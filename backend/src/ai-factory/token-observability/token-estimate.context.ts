import { DiscoveryAssessment } from '../../discovery/discovery-assessment.entity';
import { DataPipelineDesign } from '../../data-pipeline/data-pipeline-design.entity';
import { InferenceAssessment } from '../../inference/inference-assessment.entity';
import { ChunkingStrategy } from '../../chunking/enums/chunking-strategy.enum';
import { AiModelSelection } from '../model-selection/model-selection.entity';
import { AiRagAgentDesign } from '../rag-agent/rag-agent.entity';
import { RagAgentCatalogue } from '../rag-agent/rag-agent.types';
import { AiWorkloadProfile } from '../workload-profile/workload-profile.entity';
import { MANAGED_API_TIER } from './pricing';
import { EstimateContext } from './token-observability.types';

const SECONDS_PER_MONTH = 86_400 * 30.4;

export interface EstimateInputs {
  discovery: DiscoveryAssessment | null;
  pipeline: DataPipelineDesign | null;
  modelSelection: AiModelSelection | null;
  inference: InferenceAssessment | null;
  design: AiRagAgentDesign | null;
  profile: AiWorkloadProfile | null;
}

export interface EstimateCatalogues {
  ragAgent: RagAgentCatalogue;
  /** finops.yaml embedding.avgQueryTokens - the same query size FinOps prices. */
  avgQueryTokens: number;
  charsPerToken: number;
}

/** Pure: what the estimate is built from, each piece traced to the record it came from. */
export function resolveEstimateContext(x: EstimateInputs, c: EstimateCatalogues): { context: EstimateContext; sources: Record<string, { source: string; detail: string }> } {
  const sources: Record<string, { source: string; detail: string }> = {};
  const gaps: string[] = [];
  const inf = x.inference;
  const d = x.discovery;

  // ---------------------------------------------------------------- scope
  let scope: EstimateContext['scope'];
  if (x.design) {
    scope = { rag: x.design.context.rag, agent: x.design.context.agent, source: `RAG / agent design v${x.design.version}` };
  } else if (x.profile?.result.architecture.class) {
    const a = x.profile.result.architecture;
    const parts = a.class === 'hybrid' ? a.components : [a.class];
    scope = { rag: parts.includes('rag'), agent: parts.includes('agent'), source: `Workload Profile v${x.profile.version} (no RAG / agent design yet)` };
  } else {
    const w = inf?.inputsUsed.workloadType;
    scope = { rag: w === 'rag', agent: w === 'agent', source: inf ? `Inference assessment v${inf.version} workload type` : 'not yet known' };
  }
  sources.scope = { source: scope.source, detail: `RAG: ${scope.rag ? 'yes' : 'no'}; agent: ${scope.agent ? 'yes' : 'no'}` };
  if (!x.design && (scope.rag || scope.agent)) gaps.push('No RAG / agent design yet - retrieved context, reranking and agent steps are not broken down.');

  // ------------------------------------------------------------- traffic
  let requestsPerMonth = 0;
  let requestsSource: string | null = null;
  if (inf) {
    requestsPerMonth = inf.result.demand.requestsPerMonth;
    requestsSource = `Inference assessment v${inf.version}`;
  } else if (d) {
    requestsPerMonth = Math.round(d.qps * SECONDS_PER_MONTH);
    requestsSource = `Discovery v${d.version}: ${d.qps} QPS average`;
  }
  if (requestsSource) sources.requests = { source: requestsSource, detail: `${requestsPerMonth.toLocaleString()} requests / month` };

  // ----------------------------------------------------------------- LLM
  let llm: EstimateContext['llm'] = null;
  if (inf) {
    const tier = inf.inputsUsed.managedApiTier;
    const rec = inf.result.recommendedGpuOption;
    // Same serving call as Cost & FinOps: self-hosted unless there is no GPU option or the assessment chose managed.
    const selfHosted = rec && inf.result.decision !== 'managed_api' ? { monthlyUsd: rec.monthlyTotalUsd, label: `${rec.totalGpusAtPeak} × ${rec.gpuLabel}` } : null;
    const primary = x.modelSelection?.result.primary?.label;
    llm = {
      avgInputTokens: inf.inputsUsed.avgInputTokens,
      avgOutputTokens: inf.inputsUsed.avgOutputTokens,
      provider: MANAGED_API_TIER,
      model: tier.id,
      label: primary ? `${primary}, ${tier.label}` : tier.label,
      selfHosted,
      assessedPrices: { inputPer1M: tier.inputPer1M, outputPer1M: tier.outputPer1M },
      source: `Inference assessment v${inf.version}`,
    };
    sources.llm = {
      source: llm.source,
      detail: `${llm.avgInputTokens.toLocaleString()} input / ${llm.avgOutputTokens.toLocaleString()} output tokens per request; ${selfHosted ? `self-hosted on ${selfHosted.label}` : `priced as ${tier.label}`}${primary ? `; primary model ${primary} (Model Selection v${x.modelSelection!.version})` : ''}`,
    };
  } else {
    gaps.push('No Inference assessment yet - request volume, token sizes and serving are unknown.');
  }

  // ------------------------------------------------------ RAG / agent design
  let design: EstimateContext['design'] = null;
  if (x.design) {
    const t = c.ragAgent.assumptions.tokens;
    const ctx = x.design.context;
    const chosen = (area: 'reranking' | 'agent') => x.design!.result.decisions.find((a) => a.area === area)?.chosen ?? null;
    const rr = ctx.rag ? chosen('reranking') : null;
    const ag = ctx.agent ? chosen('agent') : null;
    const agentOption = ag ? c.ragAgent.agent.options.find((o) => o.id === ag.id) : undefined;
    const src = `RAG / agent design v${x.design.version}`;
    design = {
      systemPromptTokens: t.systemPrompt,
      historyTokens: ctx.multiTurn ? t.conversationHistory : 0,
      topK: ctx.topK,
      chunkTokens: ctx.chunkTokens ?? 512,
      chunkAssumed: ctx.chunkTokens === null,
      rerank: rr && rr.id !== 'none' ? { id: rr.id, label: rr.label, candidates: Math.min(ctx.topK * c.ragAgent.reranking.candidateMultiplier, c.ragAgent.reranking.maxCandidates) } : null,
      agent: ag && agentOption ? { id: ag.id, label: ag.label, maxSteps: agentOption.maxSteps, toolSchemaTokens: t.toolSchemas, toolResultPerStep: t.toolResultPerStep } : null,
      source: src,
    };
    sources.design = {
      source: src,
      detail: `top-K ${ctx.topK}, ~${design.chunkTokens} tokens per chunk${design.chunkAssumed ? ' (assumed)' : ''}${design.rerank ? `, ${design.rerank.label}` : ''}${design.agent ? `, ${design.agent.label} (max ${design.agent.maxSteps} steps)` : ''}; token assumptions from rag-agent.yaml`,
    };
  }

  // ------------------------------------------------------------- embedding
  let embedding: EstimateContext['embedding'] = null;
  const p = x.pipeline;
  if (p) {
    const chunkTokens = p.chunkingStrategy === ChunkingStrategy.TOKEN_BASED ? p.chunkSize : Math.ceil(p.chunkSize / c.charsPerToken);
    const corpusTokens = d ? d.documentCount * d.chunksPerDocument * chunkTokens : 0;
    const growth = (d?.documentGrowthPercentPerMonth ?? 0) / 100;
    const src = `Data Pipeline Design v${p.version}${d ? ` and Discovery v${d.version} corpus` : ''}`;
    embedding = { provider: p.embeddingProviderId, model: p.embeddingModelId, monthlyNewDocumentTokens: Math.round(corpusTokens * growth), source: src };
    sources.embedding = { source: src, detail: `${p.embeddingModelId}; ${embedding.monthlyNewDocumentTokens.toLocaleString()} new-document tokens / month at ${(growth * 100).toFixed(1)}% growth` };
  } else if (scope.rag) {
    gaps.push('No Data Pipeline Design yet - embedding tokens are not priced.');
  }

  // ---------------------------------------------------------------- budget
  const budgetUsd = d?.monthlyBudgetUsd ?? inf?.inputsUsed.monthlyBudgetUsd ?? null;
  const budget = budgetUsd ? { monthlyUsd: budgetUsd, source: d?.monthlyBudgetUsd ? `Discovery v${d.version}` : `Inference assessment v${inf!.version}` } : null;

  return {
    context: { scope, requestsPerMonth, requestsSource, queryTokens: c.avgQueryTokens, llm, design, embedding, budget, gaps },
    sources,
  };
}
