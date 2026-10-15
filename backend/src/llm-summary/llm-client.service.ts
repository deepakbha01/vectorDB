import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type LlmProvider = 'azure-openai' | 'openai' | 'anthropic';
const PROVIDERS: readonly LlmProvider[] = ['azure-openai', 'openai', 'anthropic'];

export interface LlmSettings {
  provider: LlmProvider;
  /** Model name; for Azure OpenAI this is the deployment name. */
  model: string;
  apiKey: string;
  baseUrl: string;
  apiVersion: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface LlmCompletion {
  text: string;
  provider: LlmProvider;
  model: string;
  /** True when the provider stopped at the output-token limit. */
  truncated: boolean;
  usage: { inputTokens: number; outputTokens: number } | null;
}

const DEFAULT_BASE_URL: Record<LlmProvider, string> = {
  'azure-openai': '',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * Reads the LLM_* settings, or returns null when they are incomplete. A key is
 * optional only for an OpenAI-compatible server at a custom LLM_BASE_URL
 * (Ollama, vLLM, LM Studio on the local network).
 */
export function readLlmSettings(config: ConfigService): LlmSettings | null {
  const get = (k: string) => String(config.get<string>(k) ?? '').trim();
  const provider = get('LLM_PROVIDER').toLowerCase() as LlmProvider;
  if (!PROVIDERS.includes(provider)) return null;
  const model = get('LLM_MODEL');
  const apiKey = get('LLM_API_KEY');
  const customBaseUrl = get('LLM_BASE_URL').replace(/\/+$/, '');
  const baseUrl = customBaseUrl || DEFAULT_BASE_URL[provider];
  if (!model || !baseUrl) return null;
  if (!apiKey && !(provider === 'openai' && customBaseUrl)) return null;
  return {
    provider,
    model,
    apiKey,
    baseUrl,
    apiVersion: get('LLM_API_VERSION') || '2024-10-21',
    maxOutputTokens: positiveInt(get('LLM_MAX_OUTPUT_TOKENS'), 1200),
    timeoutMs: positiveInt(get('LLM_TIMEOUT_MS'), 60000),
  };
}

/**
 * Minimal chat-completion client for the optional LLM summary step. Plain
 * fetch, like embedding-client, so no provider SDK is pulled in. The key is
 * read from the environment and never logged or returned.
 */
@Injectable()
export class LlmClientService {
  private readonly logger = new Logger(LlmClientService.name);

  constructor(private readonly config: ConfigService) {}

  async complete(system: string, user: string): Promise<LlmCompletion> {
    const s = readLlmSettings(this.config);
    if (!s) throw new ServiceUnavailableException('No LLM is configured on this server (see LLM_PROVIDER, LLM_MODEL and LLM_API_KEY).');
    const { url, headers, body } = this.buildRequest(s, system, user);

    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(s.timeoutMs) });
    } catch (error) {
      const reason = (error as Error).name === 'TimeoutError' ? `no answer within ${s.timeoutMs} ms` : (error as Error).message;
      this.logger.warn(`${s.provider} call failed: ${reason}`);
      throw new BadGatewayException(`The LLM provider (${s.provider}) could not be reached: ${reason}.`);
    }
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const detail = providerError(payload) ?? response.statusText;
      this.logger.warn(`${s.provider} returned ${response.status}: ${detail}`);
      throw new BadGatewayException(`The LLM provider (${s.provider}) returned ${response.status}: ${detail}`);
    }
    const parsed = s.provider === 'anthropic' ? parseAnthropic(payload) : parseOpenAi(payload);
    if (!parsed.text) throw new BadGatewayException(`The LLM provider (${s.provider}) returned an empty answer.`);
    return { ...parsed, provider: s.provider, model: s.model };
  }

  private buildRequest(s: LlmSettings, system: string, user: string): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    if (s.provider === 'anthropic') {
      return {
        url: `${s.baseUrl}/v1/messages`,
        headers: { 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01' },
        body: { model: s.model, max_tokens: s.maxOutputTokens, system, messages: [{ role: 'user', content: user }] },
      };
    }
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    if (s.provider === 'azure-openai') {
      return {
        url: `${s.baseUrl}/openai/deployments/${encodeURIComponent(s.model)}/chat/completions?api-version=${encodeURIComponent(s.apiVersion)}`,
        headers: { 'api-key': s.apiKey },
        body: { messages, max_completion_tokens: s.maxOutputTokens },
      };
    }
    // OpenAI itself takes max_completion_tokens; OpenAI-compatible local servers still expect max_tokens.
    const isOpenAi = s.baseUrl === DEFAULT_BASE_URL.openai;
    return {
      url: `${s.baseUrl}/chat/completions`,
      headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {},
      body: { model: s.model, messages, [isOpenAi ? 'max_completion_tokens' : 'max_tokens']: s.maxOutputTokens },
    };
  }
}

type Parsed = Omit<LlmCompletion, 'provider' | 'model'>;

function parseOpenAi(payload: Record<string, any> | null): Parsed {
  const choice = payload?.choices?.[0];
  const usage = payload?.usage;
  return {
    text: typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '',
    truncated: choice?.finish_reason === 'length',
    usage: usage ? { inputTokens: Number(usage.prompt_tokens) || 0, outputTokens: Number(usage.completion_tokens) || 0 } : null,
  };
}

function parseAnthropic(payload: Record<string, any> | null): Parsed {
  const blocks: Array<{ type?: string; text?: string }> = Array.isArray(payload?.content) ? payload.content : [];
  const usage = payload?.usage;
  return {
    text: blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim(),
    truncated: payload?.stop_reason === 'max_tokens',
    usage: usage ? { inputTokens: Number(usage.input_tokens) || 0, outputTokens: Number(usage.output_tokens) || 0 } : null,
  };
}

function providerError(payload: Record<string, any> | null): string | null {
  const message = payload?.error?.message ?? payload?.message;
  return typeof message === 'string' ? message.slice(0, 300) : null;
}
