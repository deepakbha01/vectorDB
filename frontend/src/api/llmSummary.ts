/** Optional LLM summary step - mirrors backend/src/llm-summary/*. */
import { apiClient } from './client';

export type LlmSummarySubject = 'vector-db-selection' | 'inference' | 'final';
export type LlmSummaryAudience = 'executive' | 'technical';

export interface LlmSummary {
  subject: LlmSummarySubject;
  audience: LlmSummaryAudience;
  text: string;
  provider: string;
  model: string;
  generatedAt: string;
  truncated: boolean;
  usage: { inputTokens: number; outputTokens: number } | null;
  source: { id: string; version: number | null; createdAt: string; rulesVersion: string };
  disclaimer: string;
}

export async function generateLlmSummary(projectId: string, subject: LlmSummarySubject, audience: LlmSummaryAudience): Promise<LlmSummary> {
  const { data } = await apiClient.post<LlmSummary>(`/projects/${projectId}/llm-summary/${subject}`, { audience });
  return data;
}
