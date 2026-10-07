import {
  ContentChangeFrequency,
  ContentModality,
  DocumentStructure,
  ExplainabilityNeed,
} from '../discovery/enums/discovery.enum';
import { VectorPlatform } from '../projects/enums/platform.enum';
import {
  AssessmentInput,
  RetrievalApproachId,
  RetrievalApproachScore,
  RetrievalFactor,
  RetrievalFamily,
  RetrievalStrategyResult,
} from './recommendation.types';

/**
 * Retrieval Strategy Assessment - "does this workload need a vector database at all?"
 *
 * Scores five retrieval approaches against the Discovery inputs: three
 * vectorless ones (long-context, reasoning-based navigation of each document's
 * section tree in the PageIndex style, and lexical/BM25 full-text search),
 * vector RAG and hybrid (lexical + vector + rerank). Every weight, gate and
 * price comes from `thresholds.yaml` -> `retrievalStrategy`.
 *
 * Pure and deterministic: no I/O, no randomness. Returns null when the
 * assessment has no query mix, so projects that never filled the section in
 * keep exactly today's Phase 4 behaviour.
 */

type Approach = { id: RetrievalApproachId; label: string; family: RetrievalFamily; how: string };
type PerApproach = Record<RetrievalApproachId, number>;
type QueryKind = 'exact' | 'multiHop' | 'semantic' | 'analytics' | 'relationship';

export const RETRIEVAL_APPROACHES: Approach[] = [
  { id: 'long_context', label: 'Long-context (no retrieval)', family: 'vectorless', how: 'Send the relevant documents straight into a long-context model and rely on prompt caching.' },
  { id: 'reasoning_navigation', label: 'Reasoning-based navigation (PageIndex-style)', family: 'vectorless', how: "Build a table-of-contents tree per document; the LLM navigates sections like an analyst and reads only what it needs." },
  { id: 'lexical', label: 'Lexical search (BM25 / full-text) + LLM', family: 'vectorless', how: 'Keyword / full-text retrieval from an existing database or search platform, then answer generation.' },
  { id: 'vector_rag', label: 'Vector RAG (embeddings + vector index)', family: 'vector', how: 'Chunk, embed and index the content; retrieve top-K by similarity, then generate.' },
  { id: 'hybrid', label: 'Hybrid (lexical + vector + rerank)', family: 'hybrid', how: 'Run lexical and vector retrieval together, fuse the results and rerank before generation.' },
];
const IDS = RETRIEVAL_APPROACHES.map((a) => a.id);
const by = (longCtx: number, reasoning: number, lexical: number, vector: number, hybrid: number): PerApproach =>
  ({ long_context: longCtx, reasoning_navigation: reasoning, lexical, vector_rag: vector, hybrid });

/** How well each approach handles each kind of question (1-5). */
const QUERY_STRENGTH: Record<RetrievalApproachId, Record<QueryKind, number>> = {
  long_context: { exact: 4, multiHop: 5, semantic: 4, analytics: 2, relationship: 3 },
  reasoning_navigation: { exact: 4, multiHop: 5, semantic: 4, analytics: 2, relationship: 3 },
  lexical: { exact: 5, multiHop: 2, semantic: 2, analytics: 1, relationship: 1 },
  vector_rag: { exact: 2, multiHop: 2, semantic: 5, analytics: 1, relationship: 1 },
  hybrid: { exact: 5, multiHop: 3, semantic: 5, analytics: 1, relationship: 2 },
};

const VECTOR_STORE_PLATFORMS = [
  VectorPlatform.MILVUS, VectorPlatform.PINECONE, VectorPlatform.QDRANT, VectorPlatform.WEAVIATE,
  VectorPlatform.CHROMA, VectorPlatform.LANCEDB, VectorPlatform.REDIS, VectorPlatform.MONGODB_ATLAS,
];

const pct = (n: number) => `${Math.round(n * 100)}%`;
const tokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : `${Math.round(n)}`);
const usd = (n: number) => Number(n.toFixed(n < 1 ? 4 : 2));

/** True when the assessment carries a usable query mix - the trigger for this assessment. */
export function hasRetrievalStrategyInputs(input: AssessmentInput): boolean {
  return [input.queryMixExactPercent, input.queryMixMultiHopPercent, input.queryMixSemanticPercent, input.queryMixAnalyticsPercent, input.queryMixRelationshipPercent]
    .some((v) => typeof v === 'number' && v > 0);
}

export function evaluateRetrievalStrategy(input: AssessmentInput, cfg: Record<string, any>): RetrievalStrategyResult | null {
  if (!cfg || !hasRetrievalStrategyInputs(input)) return null;
  const cost = cfg.costModel;

  // ---- Inputs, with stated defaults where the optional fields were left blank ----
  const docs = Math.max(1, input.documentCount ?? 1);
  const corpusTokens = docs * Math.max(0.1, input.avgDocumentSizeKb ?? 1) * cfg.tokensPerKb;
  const contextWindow = cfg.contextWindowTokens;
  const structure = input.documentStructure ?? DocumentStructure.SEMI_STRUCTURED;
  const modality = input.contentModality ?? ContentModality.TEXT;
  const change = input.contentChangeFrequency ?? ContentChangeFrequency.WEEKLY;
  const explain = input.explainabilityNeed ?? ExplainabilityNeed.STANDARD;
  const assumed = (given: unknown, text: string) => (given === undefined || given === null ? `${text} (not given - assumed)` : text);

  const rawMix: Record<QueryKind, number> = {
    exact: Math.max(0, input.queryMixExactPercent ?? 0),
    multiHop: Math.max(0, input.queryMixMultiHopPercent ?? 0),
    semantic: Math.max(0, input.queryMixSemanticPercent ?? 0),
    analytics: Math.max(0, input.queryMixAnalyticsPercent ?? 0),
    relationship: Math.max(0, input.queryMixRelationshipPercent ?? 0),
  };
  const mixTotal = Object.values(rawMix).reduce((a, b) => a + b, 0);
  const mix = Object.fromEntries(Object.entries(rawMix).map(([k, v]) => [k, v / mixTotal])) as Record<QueryKind, number>;

  const p95 = input.targetP95LatencyMs;
  const latencyBand = p95 < cfg.gates.realtimeLatencyMs ? 'realtime' : p95 <= 2000 ? 'interactive' : p95 <= 10000 ? 'patient' : 'batch';
  const peakQps = Math.max(input.qps, input.peakQps);
  const regulated = input.containsPii && !!input.regulatoryRequirements?.trim();
  const sensitivity = regulated ? 'regulated' : input.containsPii ? 'confidential' : 'internal';
  const existing = input.existingPlatforms ?? [];
  const searchStack = existing.some((p) => VECTOR_STORE_PLATFORMS.includes(p))
    ? 'vector_db'
    : existing.includes(VectorPlatform.ELASTICSEARCH)
      ? 'search_platform'
      : input.hasExistingPostgres || input.hasExistingOracle
        ? 'database_full_text'
        : 'none';

  // ---- Factors: [label, input in words, weight, per-approach score 1-5] ----
  const w = cfg.weights;
  const queryMixScore = Object.fromEntries(IDS.map((id) => [id, (Object.keys(mix) as QueryKind[]).reduce((t, k) => t + mix[k] * QUERY_STRENGTH[id][k], 0)])) as PerApproach;
  const factorRows: Array<[string, string, number, PerApproach]> = [
    ['Corpus size', `${tokens(corpusTokens)} tokens (${docs.toLocaleString('en-US')} documents x ${input.avgDocumentSizeKb ?? 1} KB)`, w.corpusSize,
      by(corpusTokens <= contextWindow * 0.2 ? 5 : corpusTokens <= contextWindow ? 3 : 1, corpusTokens <= 5e7 ? 5 : corpusTokens <= 1e9 ? 3 : 2, 5, corpusTokens < 1e6 ? 3 : 5, corpusTokens < 1e6 ? 3 : 5)],
    ['Query mix', `exact ${pct(mix.exact)}, multi-hop ${pct(mix.multiHop)}, semantic ${pct(mix.semantic)}, analytics ${pct(mix.analytics)}, relationships ${pct(mix.relationship)}`, w.queryMix, queryMixScore],
    ['Document structure', assumed(input.documentStructure, structure.replace(/_/g, ' ')), w.documentStructure,
      { structured: by(4, 5, 4, 3, 4), semi_structured: by(4, 3, 4, 4, 5), short_snippets: by(3, 1, 3, 5, 5) }[structure]],
    ['Content type', assumed(input.contentModality, modality.replace(/_/g, ' ')), w.contentModality,
      { text: by(5, 5, 5, 5, 5), text_and_tables: by(5, 5, 4, 3, 4), multimodal: by(2, 2, 1, 5, 5) }[modality]],
    ['Latency target', `P95 ${p95} ms`, w.latency,
      { realtime: by(1, 1, 4, 5, 4), interactive: by(2, 2, 5, 5, 5), patient: by(4, 4, 5, 5, 5), batch: by(5, 5, 5, 5, 5) }[latencyBand]],
    ['Explainability', assumed(input.explainabilityNeed, explain), w.explainability,
      { standard: by(4, 4, 4, 4, 4), high: by(4, 5, 4, 3, 4), regulated: by(3, 5, 4, 2, 4) }[explain]],
    ['Change frequency', assumed(input.contentChangeFrequency, change), w.changeFrequency,
      { static: by(5, 5, 5, 5, 5), weekly: by(5, 4, 5, 4, 4), daily: by(5, 3, 5, 3, 3), realtime: by(4, 2, 5, 3, 3) }[change]],
    ['Peak load', `${peakQps} queries / second`, w.peakLoad, peakQps <= 1 ? by(5, 5, 5, 5, 5) : peakQps <= 10 ? by(3, 3, 5, 5, 5) : by(1, 1, 5, 5, 4)],
    ['Data sensitivity', sensitivity === 'regulated' ? `regulated (PII, ${input.regulatoryRequirements})` : sensitivity === 'confidential' ? 'confidential (contains PII)' : 'no PII', w.dataSensitivity,
      { internal: by(5, 5, 5, 5, 5), confidential: by(3, 4, 4, 4, 4), regulated: by(2, 3, 4, 3, 3) }[sensitivity]],
    ['Existing search', { vector_db: 'a vector database already runs', search_platform: 'Elasticsearch / search platform', database_full_text: 'database full-text search (PostgreSQL / Oracle)', none: 'none' }[searchStack], w.existingSearch,
      { none: by(5, 5, 3, 3, 2), database_full_text: by(5, 5, 5, 4, 4), search_platform: by(5, 5, 5, 4, 5), vector_db: by(5, 5, 4, 5, 5) }[searchStack]],
  ];
  if (input.isMultilingual) factorRows.push(['Multilingual', 'several languages', w.multilingual, by(5, 5, 2, 5, 5)]);
  const weightTotal = factorRows.reduce((t, f) => t + f[2], 0);

  // ---- Hard gates ----
  const g = cfg.gates;
  const gates: Partial<Record<RetrievalApproachId, { factor: number; reason: string }>> = {};
  if (corpusTokens > contextWindow) gates.long_context = { factor: g.contextWindowExceededFactor, reason: `Corpus (${tokens(corpusTokens)} tokens) exceeds the ${tokens(contextWindow)}-token context window.` };
  if (latencyBand === 'realtime') {
    gates.long_context = gates.long_context ?? { factor: g.realtimeLatencyFactor, reason: `A P95 under ${g.realtimeLatencyMs} ms leaves no room for LLM calls inside retrieval.` };
    gates.reasoning_navigation = { factor: g.realtimeLatencyFactor, reason: `A P95 under ${g.realtimeLatencyMs} ms rules out multi-step LLM navigation.` };
  }
  if (modality === ContentModality.MULTIMODAL) gates.lexical = { factor: g.multimodalLexicalFactor, reason: 'Lexical search cannot match images, audio or video.' };
  if (peakQps > g.highPeakQps) gates.reasoning_navigation = gates.reasoning_navigation ?? { factor: g.highPeakQpsReasoningFactor, reason: `Peak ${peakQps} queries / second x several LLM calls each strains model rate limits.` };

  // ---- Directional cost and latency ----
  const monthlyQueries = Math.max(1, input.qps) * 3600 * cost.activeHoursPerDay * 30;
  const churn = cost.monthlyChurn[change];
  const vectorStoreGb = (corpusTokens / cost.chunkTokens) * cost.embeddingDimension * 4 * 2 / 1e9; // float32 + ~1x index/replica overhead
  const searchInfra = searchStack === 'none' ? cost.searchServiceMonthly : 0;
  const vectorInfra = searchStack === 'vector_db' ? 0 : Math.max(cost.vectorStoreMinimumMonthly, vectorStoreGb * cost.vectorStorePerGbMonth);
  const inPrice = cost.llmInputPerMillionTokens / 1e6, outPrice = cost.llmOutputPerMillionTokens / 1e6;
  const answerOut = cost.outputTokensPerAnswer * outPrice;
  const contextIn = Math.min(corpusTokens, contextWindow);
  const embeddingBuild = corpusTokens * cost.embeddingPerMillionTokens / 1e6;
  const lat = cost.latencySeconds;
  const model: Record<RetrievalApproachId, { perQuery: number; infra: number; build: number; latency: number }> = {
    // cached read on every query + a full-price cache write spread over the month's queries
    long_context: { perQuery: (contextIn * (1 - cost.cachedInputDiscount) + contextIn * Math.min(1, cost.cacheWritesPerMonth / monthlyQueries)) * inPrice + answerOut, infra: 0, build: 0, latency: lat.longContextBase + contextIn / lat.longContextTokensPerSecond },
    reasoning_navigation: { perQuery: cost.inputTokens.reasoningNavigation * inPrice + answerOut + cost.extraOutputTokens.reasoningNavigation * outPrice, infra: docs > 50 ? searchInfra : 0,
      build: corpusTokens * cost.indexBuild.reasoningInputMultiplier * inPrice + corpusTokens * cost.indexBuild.reasoningOutputShare * outPrice, latency: lat.reasoningNavigation },
    lexical: { perQuery: cost.inputTokens.lexical * inPrice + answerOut, infra: searchInfra, build: 0, latency: lat.lexical },
    vector_rag: { perQuery: cost.inputTokens.vector * inPrice + answerOut, infra: vectorInfra, build: embeddingBuild, latency: lat.vector },
    hybrid: { perQuery: cost.inputTokens.hybrid * inPrice + answerOut + cost.rerankPerThousandQueries / 1000, infra: vectorInfra + searchInfra, build: embeddingBuild, latency: lat.hybrid },
  };
  const latencyLimitSeconds = latencyBand === 'batch' ? Infinity : p95 / 1000;

  // ---- Score, gate and rank ----
  const approaches: RetrievalApproachScore[] = RETRIEVAL_APPROACHES.map((a) => {
    let score = (factorRows.reduce((t, f) => t + f[2] * f[3][a.id] / 5, 0) / weightTotal) * 100;
    const gate = gates[a.id] ?? null;
    if (gate) score *= gate.factor;
    const m = model[a.id];
    const notes: string[] = [];
    if (gate) notes.push(gate.reason);
    if (m.latency > latencyLimitSeconds) notes.push(`~${m.latency.toFixed(1)} s per answer exceeds the P95 target of ${p95} ms.`);
    if (a.id === 'reasoning_navigation' && peakQps > 10) notes.push(`~${Math.round(peakQps * 4)} LLM calls / second at peak.`);
    return {
      approach: a.id,
      label: a.label,
      family: a.family,
      score: Math.round(score),
      gate,
      costPerQueryUsd: usd(m.perQuery),
      monthlyRunCostUsd: usd(m.perQuery * monthlyQueries + m.infra + m.build * churn),
      oneTimeBuildCostUsd: usd(m.build),
      estimatedLatencySeconds: Number(m.latency.toFixed(2)),
      feasibilityNotes: notes,
    };
  }).sort((x, y) => y.score - x.score || IDS.indexOf(x.approach) - IDS.indexOf(y.approach));
  const top = approaches[0], runnerUp = approaches[1];
  const topDef = RETRIEVAL_APPROACHES.find((a) => a.id === top.approach)!;

  const factors: RetrievalFactor[] = factorRows.map(([factor, text, weight, s]) => {
    const vectorless = Math.max(s.long_context, s.reasoning_navigation, s.lexical);
    return { factor, input: text, weight, leansTo: vectorless - s.vector_rag >= 1 ? 'vectorless' : s.vector_rag - vectorless >= 1 ? 'vector' : 'neutral' };
  });

  const additionalRoutes: string[] = [];
  if (mix.analytics * 100 >= cfg.structuredRouteSharePercent) additionalRoutes.push('a text-to-SQL route for analytics questions');
  if (mix.relationship * 100 >= cfg.structuredRouteSharePercent) additionalRoutes.push('a knowledge-graph route for relationship questions');

  const headline = top.family === 'vectorless'
    ? `No dedicated vector database needed - ${top.label}`
    : top.family === 'vector' ? 'A vector database is needed - Vector RAG' : 'Hybrid retrieval - a vector database alongside full-text search';
  let rationale = topDef.how;
  if (top.approach === 'reasoning_navigation' && docs > 50) rationale += ` With ${docs.toLocaleString('en-US')} documents, add a metadata / full-text pre-filter to pick the documents before navigating them.`;
  if (top.approach === 'long_context' && corpusTokens > contextWindow * 0.2) rationale += ` The corpus fills ${Math.round((corpusTokens / contextWindow) * 100)}% of the context window - plan a pre-filter as it grows.`;
  if (additionalRoutes.length) rationale += ` Add ${additionalRoutes.join(' and ')}.`;
  if (top.family === 'vectorless') rationale += ' The ranked vector platforms remain the fallback if the evaluation below does not clear the bar.';

  const docsFilter = docs > 50 ? 'Metadata / full-text document filter, then ' : '';
  const ARCH: Record<RetrievalApproachId, Array<[string, string]>> = {
    long_context: [['Ingest', 'Clean text and tables per document, keeping page numbers'], ['Select', 'Metadata filter to the relevant documents'], ['Context', 'Cached long-context prompt'], ['Answer', 'LLM answer with page-level citations'], ['Govern', 'Access check before loading; prompt / response logging']],
    reasoning_navigation: [['Ingest', 'Parse PDFs into sections, tables and pages'], ['Index', 'LLM-built table-of-contents tree with section summaries'], ['Navigate', `${docsFilter}LLM tree search`], ['Answer', 'Read the chosen sections; cite section and page'], ['Govern', 'Navigation trace stored for audit']],
    lexical: [['Ingest', 'Sections / passages into a full-text index'], ['Retrieve', 'BM25 with field boosts and synonyms'], ['Rerank', 'Optional cross-encoder rerank'], ['Answer', 'LLM over the top passages with citations'], ['Govern', 'Row / document security in the search engine']],
    vector_rag: [['Ingest', `Chunks of ~${cost.chunkTokens} tokens with overlap and metadata`], ['Embed', 'Versioned embedding model'], ['Index', 'Vector database with metadata filters'], ['Answer', 'Top-K context into the LLM'], ['Govern', 'Re-embed on model change; access filters at retrieval']],
    hybrid: [['Ingest', 'Chunks into both full-text and vector indexes'], ['Retrieve', 'BM25 and vector search in parallel'], ['Fuse', 'Reciprocal-rank fusion plus a reranker'], ['Answer', 'LLM with citations'], ['Govern', 'One access model across both indexes']],
  };

  const golden = explain === ExplainabilityNeed.REGULATED ? 200 : explain === ExplainabilityNeed.HIGH ? 100 : 50;
  const candidates = [top.label, runnerUp.label];
  if (top.family === 'vectorless' && runnerUp.family === 'vectorless') candidates.push(approaches.find((a) => a.family !== 'vectorless')!.label);
  const count = (share: number) => Math.round(share * golden);
  const evaluationPlan = [
    `Build a golden set of ${golden} real questions with known answers and source sections, matching the query mix (${count(mix.exact)} exact, ${count(mix.multiHop)} multi-hop, ${count(mix.semantic)} semantic${mix.analytics + mix.relationship > 0 ? `, ${count(mix.analytics + mix.relationship)} analytics / relationship` : ''}).`,
    `Run ${candidates.join(', ')} on a representative slice of ${Math.min(docs, 50)} documents.`,
    'Measure answer accuracy, citation correctness, retrieval recall (right section found), P95 latency and cost per query.',
    `Pass bar: accuracy >= ${explain === ExplainabilityNeed.REGULATED ? 95 : explain === ExplainabilityNeed.HIGH ? 90 : 85}%, citations correct >= ${explain === ExplainabilityNeed.STANDARD ? 85 : 95}%, P95 within ${p95} ms.`,
    'Choose the cheapest approach that clears the bar; re-run the set whenever the model, prompts or content change.',
  ];

  return {
    recommendedApproach: top.approach,
    recommendedFamily: top.family,
    vectorDatabaseRequired: top.family !== 'vectorless',
    headline,
    rationale,
    additionalRoutes,
    closeCall: top.score - runnerUp.score < cfg.closeCallPoints,
    approaches,
    factors,
    corpusTokens: Math.round(corpusTokens),
    normalizedQueryMix: { exact: mix.exact, multiHop: mix.multiHop, semantic: mix.semantic, analytics: mix.analytics, relationship: mix.relationship },
    referenceArchitecture: ARCH[top.approach].map(([layer, detail]) => ({ layer, detail })),
    evaluationPlan,
  };
}
