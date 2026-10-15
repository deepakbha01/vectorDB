import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/auth.service';
import { User } from '../users/user.entity';
import { parseSecretKey, seal, unseal } from '../database-adapters/connection/secret-box';
import { buildLlmSettings, LLM_PROVIDERS, LlmClientService, LlmProvider, LlmSettings, readLlmLimits, readLlmSettings } from './llm-client.service';
import { LlmConnection } from './llm-connection.entity';
import { CreateLlmConnectionDto, UpdateLlmConnectionDto } from './llm-connection.dto';

/** Id of the integration defined by the server's LLM_* settings; it cannot be edited in the app. */
export const SERVER_CONNECTION_ID = 'server';

export interface LlmConnectionView {
  id: string;
  name: string;
  provider: string;
  providerLabel: string;
  model: string;
  baseUrl: string | null;
  apiVersion: string | null;
  /** Whether a key is stored - never the key itself. */
  hasApiKey: boolean;
  isDefault: boolean;
  /** True for the one from the server's LLM_* settings. */
  fromServerSettings: boolean;
  /** False when the settings are incomplete (for example a required key or base URL is missing). */
  ready: boolean;
  updatedAt: string | null;
}

export interface ResolvedLlm {
  connectionId: string;
  connectionName: string;
  settings: LlmSettings;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const label = (provider: string) => (LLM_PROVIDERS as Record<string, { label: string }>)[provider]?.label ?? provider;

const cleanUrl = (raw: string | undefined | null): string | null => {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    throw new BadRequestException('The base URL is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BadRequestException('The base URL must start with https:// or http://.');
  if (url.username || url.password) throw new BadRequestException('Put credentials in the API key field, not in the base URL.');
  return t.replace(/\/+$/, '');
};

/**
 * LLM integrations added in the app, plus the server's own LLM_* settings
 * shown as a read-only entry. Keys are write-only and stored sealed.
 */
@Injectable()
export class LlmConnectionsService {
  constructor(
    private readonly config: ConfigService,
    private readonly llm: LlmClientService,
    private readonly dataSource: DataSource,
    @InjectRepository(LlmConnection) private readonly connections: Repository<LlmConnection>,
  ) {}

  private key(): Buffer | null {
    return parseSecretKey(this.config.get<string>('CONNECTION_SECRET_KEY'));
  }

  private requireKey(): Buffer {
    const key = this.key();
    if (!key) throw new BadRequestException('Set CONNECTION_SECRET_KEY on the server (32 bytes, hex or base64) before saving an LLM integration. Keys are never stored unencrypted.');
    return key;
  }

  private openKey(c: LlmConnection): string {
    if (!c.apiKeySealed) return '';
    const key = this.key();
    if (!key) throw new ServiceUnavailableException('The server has no valid CONNECTION_SECRET_KEY, so saved LLM keys cannot be opened.');
    try {
      return unseal(c.apiKeySealed, key);
    } catch {
      throw new ServiceUnavailableException(`The key saved for "${c.name}" cannot be opened with the server's CONNECTION_SECRET_KEY (was it changed?). Enter the key again.`);
    }
  }

  private settingsOf(c: LlmConnection): LlmSettings | null {
    return buildLlmSettings({ provider: c.provider, model: c.model, apiKey: this.openKey(c), baseUrl: c.baseUrl, apiVersion: c.apiVersion }, readLlmLimits(this.config));
  }

  private view(c: LlmConnection): LlmConnectionView {
    const ready = buildLlmSettings({ provider: c.provider, model: c.model, apiKey: c.apiKeySealed ? 'set' : '', baseUrl: c.baseUrl, apiVersion: c.apiVersion }, readLlmLimits(this.config)) !== null;
    return {
      id: c.id,
      name: c.name,
      provider: c.provider,
      providerLabel: label(c.provider),
      model: c.model,
      baseUrl: c.baseUrl,
      apiVersion: c.apiVersion,
      hasApiKey: !!c.apiKeySealed,
      isDefault: c.isDefault,
      fromServerSettings: false,
      ready,
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  private serverView(hasDefault: boolean): LlmConnectionView | null {
    const s = readLlmSettings(this.config);
    if (!s) return null;
    const custom = String(this.config.get<string>('LLM_BASE_URL') ?? '').trim();
    return {
      id: SERVER_CONNECTION_ID,
      name: 'Server default (.env)',
      provider: s.provider,
      providerLabel: label(s.provider),
      model: s.model,
      baseUrl: custom || null,
      apiVersion: s.protocol === 'azure-openai' ? s.apiVersion : null,
      hasApiKey: !!s.apiKey,
      isDefault: !hasDefault,
      fromServerSettings: true,
      ready: true,
      updatedAt: null,
    };
  }

  async list(): Promise<LlmConnectionView[]> {
    const rows = await this.connections.find({ order: { isDefault: 'DESC', name: 'ASC' } });
    const server = this.serverView(rows.some((r) => r.isDefault));
    return [...rows.map((r) => this.view(r)), ...(server ? [server] : [])];
  }

  private async get(id: string): Promise<LlmConnection> {
    if (id === SERVER_CONNECTION_ID) throw new BadRequestException('The server default comes from backend/.env and cannot be changed here.');
    const c = UUID.test(id) ? await this.connections.findOne({ where: { id } }) : null;
    if (!c) throw new NotFoundException('That LLM integration does not exist.');
    return c;
  }

  /** Saves `c`, clearing every other default first when it is the default. */
  private async save(c: LlmConnection): Promise<LlmConnection> {
    return this.dataSource.transaction(async (m) => {
      if (c.isDefault) await m.update(LlmConnection, { isDefault: true }, { isDefault: false });
      return m.save(LlmConnection, c);
    });
  }

  async create(dto: CreateLlmConnectionDto, user: AuthenticatedUser): Promise<LlmConnectionView> {
    const apiKey = dto.apiKey?.trim();
    const c = this.connections.create({
      name: dto.name.trim(),
      provider: dto.provider,
      model: dto.model.trim(),
      baseUrl: cleanUrl(dto.baseUrl),
      apiVersion: dto.apiVersion?.trim() || null,
      apiKeySealed: apiKey ? seal(apiKey, this.requireKey()) : null,
      isDefault: dto.isDefault ?? (await this.connections.count()) === 0,
      updatedBy: { id: user.id } as User,
    });
    return this.view(await this.save(c));
  }

  async update(id: string, dto: UpdateLlmConnectionDto, user: AuthenticatedUser): Promise<LlmConnectionView> {
    const c = await this.get(id);
    if (dto.name !== undefined) c.name = dto.name.trim();
    if (dto.provider !== undefined) c.provider = dto.provider;
    if (dto.model !== undefined) c.model = dto.model.trim();
    if (dto.baseUrl !== undefined) c.baseUrl = cleanUrl(dto.baseUrl);
    if (dto.apiVersion !== undefined) c.apiVersion = dto.apiVersion.trim() || null;
    if (dto.apiKey !== undefined) c.apiKeySealed = dto.apiKey.trim() ? seal(dto.apiKey.trim(), this.requireKey()) : null;
    if (dto.isDefault !== undefined) c.isDefault = dto.isDefault;
    c.updatedBy = { id: user.id } as User;
    return this.view(await this.save(c));
  }

  async remove(id: string): Promise<void> {
    await this.connections.remove(await this.get(id));
  }

  /** Sends a tiny prompt to check the provider, model and key work. */
  async test(id: string): Promise<{ ok: true; provider: LlmProvider; model: string; latencyMs: number; reply: string }> {
    const { settings } = await this.resolve(id);
    const start = Date.now();
    const out = await this.llm.complete('You are a connectivity check. Answer in at most five words.', 'Reply with: connection OK', { ...settings, maxOutputTokens: 64 });
    return { ok: true, provider: out.provider, model: out.model, latencyMs: Date.now() - start, reply: out.text.slice(0, 200) };
  }

  /**
   * The integration a summary uses: the one asked for, else the saved default,
   * else the server's LLM_* settings.
   */
  async resolve(connectionId?: string): Promise<ResolvedLlm> {
    if (connectionId === SERVER_CONNECTION_ID) return this.fromServer();
    if (connectionId) return this.fromRow(await this.get(connectionId));
    const def = await this.connections.findOne({ where: { isDefault: true } });
    if (def) return this.fromRow(def);
    const server = readLlmSettings(this.config);
    if (server) return { connectionId: SERVER_CONNECTION_ID, connectionName: 'Server default (.env)', settings: server };
    const first = await this.connections.findOne({ where: {}, order: { name: 'ASC' } });
    if (first) return this.fromRow(first);
    throw new ServiceUnavailableException('No LLM integration is set up yet. An admin can add one under Settings > LLM integrations.');
  }

  private fromServer(): ResolvedLlm {
    const s = readLlmSettings(this.config);
    if (!s) throw new BadRequestException('The server default LLM is not configured (backend/.env LLM_* settings).');
    return { connectionId: SERVER_CONNECTION_ID, connectionName: 'Server default (.env)', settings: s };
  }

  private fromRow(c: LlmConnection): ResolvedLlm {
    const settings = this.settingsOf(c);
    if (!settings) throw new BadRequestException(`"${c.name}" is incomplete - check its model, API key and base URL under Settings > LLM integrations.`);
    return { connectionId: c.id, connectionName: c.name, settings };
  }
}
