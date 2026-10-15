/** Optional LLM summary step and its integrations - mirrors backend/src/llm-summary/*. */
import { apiClient } from './client';

export type LlmSummarySubject = 'vector-db-selection' | 'inference' | 'final';
export type LlmSummaryAudience = 'executive' | 'technical';

export const LLM_SUMMARY_SUBJECT_LABELS: Record<LlmSummarySubject, string> = {
  'vector-db-selection': 'Vector DB Selection',
  inference: 'Inference Assessment',
  final: 'Final Recommendation',
};

export interface LlmSummary {
  subject: LlmSummarySubject;
  audience: LlmSummaryAudience;
  text: string;
  provider: string;
  model: string;
  connection: { id: string; name: string };
  generatedAt: string;
  truncated: boolean;
  usage: { inputTokens: number; outputTokens: number } | null;
  source: { id: string; version: number | null; createdAt: string; rulesVersion: string };
  disclaimer: string;
}

export interface LlmProviderOption {
  id: string;
  label: string;
  defaultBaseUrl: string | null;
  baseUrlRequired: boolean;
  keyOptional: boolean;
  apiVersionUsed: boolean;
  exampleModel: string;
}

export interface LlmConnection {
  id: string;
  name: string;
  provider: string;
  providerLabel: string;
  model: string;
  baseUrl: string | null;
  apiVersion: string | null;
  hasApiKey: boolean;
  isDefault: boolean;
  /** The read-only entry from the server's backend/.env LLM_* settings. */
  fromServerSettings: boolean;
  ready: boolean;
  updatedAt: string | null;
}

/** Fields of the add/edit form. An omitted apiKey keeps the stored one; '' clears it. */
export interface LlmConnectionInput {
  name?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiVersion?: string;
  apiKey?: string;
  isDefault?: boolean;
}

export async function generateLlmSummary(projectId: string, subject: LlmSummarySubject, audience: LlmSummaryAudience, connectionId?: string): Promise<LlmSummary> {
  const { data } = await apiClient.post<LlmSummary>(`/projects/${projectId}/llm-summary/${subject}`, { audience, ...(connectionId ? { connectionId } : {}) });
  return data;
}

export const listLlmProviders = () => apiClient.get<LlmProviderOption[]>('/llm-connections/providers').then((r) => r.data);
export const listLlmConnections = () => apiClient.get<LlmConnection[]>('/llm-connections').then((r) => r.data);
export const createLlmConnection = (body: LlmConnectionInput) => apiClient.post<LlmConnection>('/llm-connections', body).then((r) => r.data);
export const updateLlmConnection = (id: string, body: LlmConnectionInput) => apiClient.patch<LlmConnection>(`/llm-connections/${id}`, body).then((r) => r.data);
export const deleteLlmConnection = (id: string) => apiClient.delete(`/llm-connections/${id}`);
export const testLlmConnection = (id: string) =>
  apiClient.post<{ ok: true; provider: string; model: string; latencyMs: number; reply: string }>(`/llm-connections/${id}/test`).then((r) => r.data);
