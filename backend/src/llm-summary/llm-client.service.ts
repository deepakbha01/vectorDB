import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type Protocol = 'openai' | 'azure-openai' | 'anthropic';

interface ProviderPreset {
  label: string;
  /** Which wire format the provider speaks. */
  protocol: Protocol;
  /** Used when no base URL is given; '' means one is required. */
  defaultBaseUrl: string;
  /** Local servers usually run without a key. */
  keyOptional?: boolean;
  /** Shown as a placeholder in the integrations form. */
  exampleModel: string;
}

/**
 * Supported providers (LLM_PROVIDER or a saved integration). Most hosted
 * providers expose an OpenAI-compatible chat-completions API, so adding one is
 * a new row here.
 */
export const LLM_PROVIDERS = {
  openai: { label: 'OpenAI', protocol: 'openai', defaultBaseUrl: 'https://api.openai.com/v1', exampleModel: 'gpt-4o' },
  'azure-openai': { label: 'Azure OpenAI', protocol: 'azure-openai', defaultBaseUrl: '', exampleModel: 'your deployment name' },
  anthropic: { label: 'Anthropic (Claude)', protocol: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com', exampleModel: 'claude-sonnet-5-5' },
  gemini: { label: 'Google Gemini', protocol: 'openai', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', exampleModel: 'gemini-2.5-flash' },
  mistral: { label: 'Mistral', protocol: 'openai', defaultBaseUrl: 'https://api.mistral.ai/v1', exampleModel: 'mistral-large-latest' },
  groq: { label: 'Groq', protocol: 'openai', defaultBaseUrl: 'https://api.groq.com/openai/v1', exampleModel: 'llama-3.3-70b-versatile' },
  deepseek: { label: 'DeepSeek', protocol: 'openai', defaultBaseUrl: 'https://api.deepseek.com/v1', exampleModel: 'deepseek-chat' },
  xai: { label: 'xAI (Grok)', protocol: 'openai', defaultBaseUrl: 'https://api.x.ai/v1', exampleModel: 'grok-4' },
  openrouter: { label: 'OpenRouter', protocol: 'openai', defaultBaseUrl: 'https://openrouter.ai/api/v1', exampleModel: 'anthropic/claude-sonnet-5-5' },
  together: { label: 'Together AI', protocol: 'openai', defaultBaseUrl: 'https://api.together.xyz/v1', exampleModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  ollama: { label: 'Ollama (local)', protocol: 'openai', defaultBaseUrl: 'http://localhost:11434/v1', keyOptional: true, exampleModel: 'llama3.1' },
  /** Any other OpenAI-compatible server (vLLM, LM Studio, LiteLLM, an internal gateway). */
  'openai-compatible': { label: 'Other OpenAI-compatible server', protocol: 'openai', defaultBaseUrl: '', keyOptional: true, exampleModel: 'model name on that server' },
  /** Any service that speaks the Anthropic Messages API at its own URL. */
  'anthropic-compatible': { label: 'Other Anthropic-compatible service', protocol: 'anthropic', defaultBaseUrl: '', exampleModel: 'model name on that service' },
} satisfies Record<string, ProviderPreset>;

export type LlmProvider = keyof typeof LLM_PROVIDERS;

export const isLlmProvider = (p: string): p is LlmProvider => Object.prototype.hasOwnProperty.call(LLM_PROVIDERS, p);

/** The provider list for the integrations form. */
export function llmProviderCatalogue() {
  return Object.entries(LLM_PROVIDERS).map(([id, p]: [string, ProviderPreset]) => ({
    id,
    label: p.label,
    defaultBaseUrl: p.defaultBaseUrl || null,
    baseUrlRequired: !p.defaultBaseUrl,
    keyOptional: !!p.keyOptional,
    apiVersionUsed: p.protocol === 'azure-openai',
    exampleModel: p.exampleModel,
  }));
}

export interface LlmSettings {
  provider: LlmProvider;
  protocol: Protocol;
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

/** Rate-limited or overloaded - worth a retry. 529 is Anthropic's "overloaded". */
const BUSY_STATUSES = new Set([429, 503, 529]);

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export interface LlmSettingsInput {
  provider: string;
  model: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  apiVersion?: string | null;
}

/**
 * Settings from raw values, or null when they are incomplete. A key is
 * optional only for local servers (ollama, openai-compatible) and for openai
 * pointed at a custom base URL, which predates the openai-compatible preset.
 */
export function buildLlmSettings(input: LlmSettingsInput, limits: { maxOutputTokens: number; timeoutMs: number }): LlmSettings | null {
  const provider = String(input.provider ?? '').trim().toLowerCase();
  if (!isLlmProvider(provider)) return null;
  const preset: ProviderPreset = LLM_PROVIDERS[provider];
  const model = String(input.model ?? '').trim();
  const apiKey = String(input.apiKey ?? '').trim();
  const customBaseUrl = String(input.baseUrl ?? '').trim().replace(/\/+$/, '');
  const baseUrl = customBaseUrl || preset.defaultBaseUrl;
  if (!model || !baseUrl) return null;
  if (!apiKey && !preset.keyOptional && !(provider === 'openai' && customBaseUrl)) return null;
  return { provider, protocol: preset.protocol, model, apiKey, baseUrl, apiVersion: String(input.apiVersion ?? '').trim() || '2024-10-21', ...limits };
}

/** Output-token and timeout limits; server-wide, also for saved integrations. */
export function readLlmLimits(config: ConfigService) {
  const get = (k: string) => String(config.get<string>(k) ?? '').trim();
  return { maxOutputTokens: positiveInt(get('LLM_MAX_OUTPUT_TOKENS'), 4096), timeoutMs: positiveInt(get('LLM_TIMEOUT_MS'), 120000) };
}

/** The server-default LLM from the LLM_* settings, or null when they are incomplete. */
export function readLlmSettings(config: ConfigService): LlmSettings | null {
  const get = (k: string) => String(config.get<string>(k) ?? '').trim();
  return buildLlmSettings(
    { provider: get('LLM_PROVIDER'), model: get('LLM_MODEL'), apiKey: get('LLM_API_KEY'), baseUrl: get('LLM_BASE_URL'), apiVersion: get('LLM_API_VERSION') },
    readLlmLimits(config),
  );
}

/**
 * Minimal chat-completion client for the optional LLM summary step. Plain
 * fetch, like embedding-client, so no provider SDK is pulled in. Keys come
 * from the environment or a saved integration and are never logged or returned.
 */
@Injectable()
export class LlmClientService {
  private readonly logger = new Logger(LlmClientService.name);

  /** Waits before each retry of a busy provider (429, 503, 529); all within one timeout. */
  retryDelaysMs = [2000, 5000];

  constructor(private readonly config: ConfigService) {}

  /** Uses `settings` (a saved integration) when given, else the server's LLM_* settings. */
  async complete(system: string, user: string, settings?: LlmSettings): Promise<LlmCompletion> {
    const s = settings ?? readLlmSettings(this.config);
    if (!s) throw new ServiceUnavailableException('No LLM is configured on this server (see LLM_PROVIDER, LLM_MODEL and LLM_API_KEY).');
    const { url, headers, body } = this.buildRequest(s, system, user);
    const deadline = Date.now() + s.timeoutMs;

    let response: Response;
    let payload: Record<string, unknown> | null;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      } catch (error) {
        const reason = (error as Error).name === 'TimeoutError' ? `no answer within ${s.timeoutMs} ms` : (error as Error).message;
        this.logger.warn(`${s.provider} call failed: ${reason}`);
        throw new BadGatewayException(`The LLM provider (${s.provider}) could not be reached: ${reason}.`);
      }
      payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const wait = this.retryDelaysMs[attempt];
      if (response.ok || !BUSY_STATUSES.has(response.status) || wait === undefined || Date.now() + wait >= deadline) break;
      this.logger.warn(`${s.provider} is busy (${response.status}); retrying in ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
    if (!response.ok) {
      const detail = providerError(payload) ?? response.statusText;
      this.logger.warn(`${s.provider} returned ${response.status}: ${detail}`);
      const retried = BUSY_STATUSES.has(response.status) ? ' (retried; the provider is still busy - try again in a minute or pick another integration)' : '';
      throw new BadGatewayException(`The LLM provider (${s.provider}) returned ${response.status}: ${detail}${retried}`);
    }
    const parsed = s.protocol === 'anthropic' ? parseAnthropic(payload) : parseOpenAi(payload);
    if (!parsed.text) {
      // Thinking models can spend the whole output budget on reasoning and return no text.
      const hint = parsed.truncated ? ` It stopped at the ${s.maxOutputTokens}-token output limit, likely spent on reasoning - raise LLM_MAX_OUTPUT_TOKENS or pick a non-thinking model.` : '';
      throw new BadGatewayException(`The LLM provider (${s.provider}) returned an empty answer.${hint}`);
    }
    return { ...parsed, provider: s.provider, model: s.model };
  }

  private buildRequest(s: LlmSettings, system: string, user: string): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    if (s.protocol === 'anthropic') {
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
    if (s.protocol === 'azure-openai') {
      return {
        url: `${s.baseUrl}/openai/deployments/${encodeURIComponent(s.model)}/chat/completions?api-version=${encodeURIComponent(s.apiVersion)}`,
        headers: { 'api-key': s.apiKey },
        body: { messages, max_completion_tokens: s.maxOutputTokens },
      };
    }
    // OpenAI itself takes max_completion_tokens; the OpenAI-compatible providers still expect max_tokens.
    const isOpenAi = s.baseUrl === LLM_PROVIDERS.openai.defaultBaseUrl;
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
  // Gemini's OpenAI-compatible endpoint wraps its error in a one-element array.
  const body = Array.isArray(payload) ? payload[0] : payload;
  const message = body?.error?.message ?? body?.message;
  const status = typeof body?.error?.status === 'string' ? ` (${body.error.status})` : '';
  return typeof message === 'string' ? `${message.slice(0, 300)}${status}` : null;
}
