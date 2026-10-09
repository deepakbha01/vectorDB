/**
 * Azure AI Factory Builder - Phase 2 (Use case intake) core.
 *
 * The UseCaseSpec (spec 6.2) and the intake classifier (spec 10.2). The
 * classifier honours the spec's contract - it returns { pattern, confidence,
 * rationale, missingInfo, riskClass }, validated against a schema - but runs
 * offline: a deterministic, explainable keyword-and-signal scorer over the
 * wizard answers. An LLM implementation can replace it in the live-Azure wave
 * behind the same contract; nothing downstream changes. Pure - no I/O.
 *
 * The classifier never invents requirements: gaps go to `missingInfo`.
 */

export type SolutionPattern = 'rag-assistant' | 'agentic-workflow' | 'document-intelligence' | 'conversational-copilot' | 'predictive-ml';
export type RiskClass = 'low' | 'medium' | 'high';
export type UserType = 'internal' | 'external' | 'mixed';
export type Channel = 'web' | 'teams' | 'mobile' | 'api' | 'email';
export type DataClassification = 'public' | 'internal' | 'confidential' | 'restricted';
export type DataRefresh = 'static' | 'weekly' | 'daily' | 'hourly' | 'realtime';
export type TargetEnvironment = 'dev' | 'test' | 'prod';

export const SOLUTION_PATTERNS: Array<{ id: SolutionPattern; label: string; typical: string; mvp: boolean }> = [
  { id: 'rag-assistant', label: 'RAG knowledge assistant', typical: 'Policy / knowledge Q&A over documents', mvp: true },
  { id: 'agentic-workflow', label: 'Agentic workflow', typical: 'Multi-step agents calling tools and APIs', mvp: false },
  { id: 'document-intelligence', label: 'Document intelligence', typical: 'Invoice, contract and form extraction', mvp: false },
  { id: 'conversational-copilot', label: 'Conversational copilot', typical: 'Customer / employee chat in Teams or web', mvp: false },
  { id: 'predictive-ml', label: 'Predictive ML', typical: 'Forecasting and classification on tabular data', mvp: false },
];

export interface DataSourceSpec {
  source: string;
  format: string;
  volumeGb: number;
  classification: DataClassification;
  containsPersonalData: boolean;
  refresh: DataRefresh;
}

/** The wizard's answers - everything in the UseCaseSpec except the classifier's pattern block. */
export interface IntakeAnswers {
  name: string;
  business: { problem: string; kpis: string[]; sponsor: string; costCenter: string };
  users: { type: UserType; count: number; peakConcurrent: number; channels: Channel[] };
  data: DataSourceSpec[];
  constraints: { regions: string[]; dataResidency: string | null; compliance: string[]; latencyMs: number | null; availability: string | null; monthlyBudgetUsd: number | null };
  environment: TargetEnvironment;
}

/** Spec 10.2 output. */
export interface Classification {
  pattern: SolutionPattern;
  confidence: number;
  rationale: string;
  missingInfo: string[];
  riskClass: RiskClass;
}

export interface ClassificationDetail extends Classification {
  /** Classifier implementation and version, stored with every output (spec 10.1). */
  classifier: string;
  /** Raw score per pattern, so the choice can be checked. */
  scores: Record<SolutionPattern, number>;
  /** The words and signals that drove each pattern's score. */
  signals: Record<SolutionPattern, string[]>;
  riskReasons: string[];
}

export interface PatternChoice {
  id: SolutionPattern;
  confidence: number;
  rationale: string;
  /** Set when an architect overrode the classifier: who, and why. */
  overriddenBy: string | null;
  overrideReason: string | null;
  classifiedAs: SolutionPattern;
  missingInfo: string[];
  riskClass: RiskClass;
  /** False for patterns the MVP cannot design yet (only the RAG assistant in Phase 3). */
  supportedInMvp: boolean;
}

export interface UseCaseSpec extends IntakeAnswers {
  pattern: PatternChoice;
  owner: string;
}

export const CLASSIFIER_ID = 'deterministic-keyword-v1';

/**
 * Keyword evidence per pattern, case-insensitive. A keyword matches as a whole
 * word with a common ending (form, forms; extract, extraction); a trailing `*`
 * marks a stem that matches as a prefix (orchestrat* -> orchestrate, orchestration).
 */
const KEYWORDS: Record<SolutionPattern, string[]> = {
  'rag-assistant': ['question', 'answer', 'q&a', 'knowledge', 'policy', 'policies', 'search', 'find', 'lookup', 'document', 'manual', 'handbook', 'guideline', 'faq', 'sop', 'ground', 'cite', 'citation', 'rag', 'retriev*', 'retrieval-augmented', 'evidence', 'semantic search', 'vector'],
  'agentic-workflow': ['automate', 'automation', 'workflow', 'agent', 'agentic', 'multi-step', 'orchestrat*', 'tool', 'action', 'approve', 'approval', 'trigger', 'book', 'schedule', 'update record', 'create ticket', 'raise ticket'],
  'document-intelligence': ['extract', 'extraction', 'invoice', 'receipt', 'form', 'contract', 'ocr', 'scan', 'field', 'key-value', 'purchase order', 'claim form', 'kyc', 'digitis*', 'digitiz*'],
  'conversational-copilot': ['chat', 'chatbot', 'conversation', 'copilot', 'helpdesk', 'help desk', 'customer service', 'virtual agent', 'self-service', 'deflect'],
  'predictive-ml': ['forecast', 'predict', 'prediction', 'churn', 'propensity', 'score', 'scoring', 'classification', 'anomaly', 'demand', 'regression', 'tabular', 'time series', 'fraud'],
};

const DOC_FORMATS = /\b(pdf|docx?|pptx?|html?|wiki|sharepoint|confluence|txt|md)\b/i;
const TABULAR_FORMATS = /\b(csv|parquet|sql|table|tabular|warehouse|database|excel|xlsx)\b/i;
const SCANNED = /\b(scan|image|tiff?|jpe?g|png)\b/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matchesKeyword(text: string, kw: string): boolean {
  if (kw.endsWith('*')) return new RegExp(`(^|[^a-z])${escapeRe(kw.slice(0, -1))}`, 'i').test(text);
  return new RegExp(`(^|[^a-z])${escapeRe(kw)}(s|es|d|ed|ing|ion|ions)?($|[^a-z])`, 'i').test(text);
}

/** Deterministic intake classifier (spec 10.2 contract). */
export function classifyUseCase(a: IntakeAnswers): ClassificationDetail {
  const text = [a.name, a.business.problem, ...a.business.kpis].join(' ').toLowerCase();
  const scores = Object.fromEntries(SOLUTION_PATTERNS.map((p) => [p.id, 0])) as Record<SolutionPattern, number>;
  const signals = Object.fromEntries(SOLUTION_PATTERNS.map((p) => [p.id, [] as string[]])) as Record<SolutionPattern, string[]>;
  const add = (p: SolutionPattern, points: number, why: string) => { scores[p] += points; signals[p].push(why); };

  for (const p of SOLUTION_PATTERNS) for (const kw of KEYWORDS[p.id]) if (matchesKeyword(text, kw)) add(p.id, 1, `"${kw}"`);
  // Nearly every RAG app is called an assistant too, so the word alone does not decide between the two.
  if (matchesKeyword(text, 'assistant')) { add('conversational-copilot', 0.5, '"assistant"'); add('rag-assistant', 0.5, '"assistant"'); }

  // Structured signals from the data and channels
  const formats = a.data.map((d) => `${d.source} ${d.format}`).join(' ');
  if (DOC_FORMATS.test(formats)) { add('rag-assistant', 1.5, 'document data sources'); add('document-intelligence', 0.5, 'document data sources'); }
  if (SCANNED.test(formats)) add('document-intelligence', 1.5, 'scanned / image documents');
  if (TABULAR_FORMATS.test(formats)) add('predictive-ml', 1.5, 'tabular data sources');
  if (a.users.channels.includes('teams')) { add('conversational-copilot', 1, 'Teams channel'); add('rag-assistant', 0.5, 'Teams channel'); }
  if (a.users.channels.includes('web') && a.users.type !== 'internal') add('conversational-copilot', 0.5, 'external web channel');
  if (a.users.channels.includes('api') && a.users.channels.length === 1) { add('predictive-ml', 0.5, 'API-only consumers'); add('agentic-workflow', 0.5, 'API-only consumers'); }

  const ranked = [...SOLUTION_PATTERNS.map((p) => p.id)].sort((x, y) => scores[y] - scores[x] || order(x) - order(y));
  const top = ranked[0];
  const total = Object.values(scores).reduce((s, v) => s + v, 0);
  const missingInfo = findMissingInfo(a);
  // Confidence: share of the evidence the winner holds, damped when there is little evidence or many gaps.
  let confidence = total === 0 ? 0.2 : scores[top] / total;
  if (total < 3) confidence *= 0.7;
  confidence = Math.max(0.05, Math.min(0.99, confidence - missingInfo.length * 0.03));
  const { riskClass, reasons } = assessRisk(a);
  const label = SOLUTION_PATTERNS.find((p) => p.id === top)!.label;
  const rationale = total === 0
    ? `No pattern evidence in the answers; defaulting to the ${label}. Describe the problem in more detail.`
    : `${label}: ${signals[top].slice(0, 5).join(', ')}.${scores[ranked[1]] > 0 ? ` Next: ${SOLUTION_PATTERNS.find((p) => p.id === ranked[1])!.label}.` : ''}`;

  return {
    pattern: total === 0 ? 'rag-assistant' : top,
    confidence: Number(confidence.toFixed(2)),
    rationale: truncateWords(rationale, 60),
    missingInfo,
    riskClass,
    classifier: CLASSIFIER_ID,
    scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Number(v.toFixed(2))])) as Record<SolutionPattern, number>,
    signals,
    riskReasons: reasons,
  };
}

const order = (p: SolutionPattern) => SOLUTION_PATTERNS.findIndex((x) => x.id === p);

function truncateWords(s: string, max: number): string {
  const words = s.split(/\s+/);
  return words.length <= max ? s : words.slice(0, max).join(' ') + '...';
}

/** Spec 10.2: high if personal or regulated data is involved, or users are external. */
export function assessRisk(a: IntakeAnswers): { riskClass: RiskClass; reasons: string[] } {
  const reasons: string[] = [];
  if (a.data.some((d) => d.containsPersonalData)) reasons.push('personal data');
  if (a.constraints.compliance.length) reasons.push(`regulated (${a.constraints.compliance.join(', ')})`);
  if (a.users.type !== 'internal') reasons.push(`${a.users.type} users`);
  if (a.data.some((d) => d.classification === 'restricted')) reasons.push('restricted data');
  if (reasons.length) return { riskClass: 'high', reasons };
  if (a.data.some((d) => d.classification === 'confidential')) return { riskClass: 'medium', reasons: ['confidential data'] };
  return { riskClass: 'low', reasons: ['internal users, no personal or regulated data'] };
}

/** Gaps the architect should close; never filled in by guessing. */
export function findMissingInfo(a: IntakeAnswers): string[] {
  const gaps: string[] = [];
  if (a.business.problem.trim().split(/\s+/).length < 8) gaps.push('A fuller problem statement (who has the problem and what changes when it is solved)');
  if (!a.business.kpis.length) gaps.push('At least one measurable KPI');
  if (!a.business.sponsor.trim()) gaps.push('Business sponsor');
  if (!a.business.costCenter.trim()) gaps.push('Cost center (needed for the mandatory costCenter tag)');
  if (!a.users.count) gaps.push('Number of users');
  if (!a.users.channels.length) gaps.push('How users will reach it (web, Teams, API...)');
  if (!a.data.length) gaps.push('At least one data source');
  if (a.data.some((d) => !d.volumeGb)) gaps.push('Data volume for every source');
  if (!a.constraints.regions.length) gaps.push('Allowed region(s)');
  if (a.constraints.latencyMs == null) gaps.push('Target response time');
  if (a.constraints.monthlyBudgetUsd == null) gaps.push('Monthly budget');
  return gaps;
}

/** Business rules the schema alone cannot express. Returns readable problems. */
export function validateIntake(a: IntakeAnswers): string[] {
  const errors: string[] = [];
  if (a.users.peakConcurrent > a.users.count && a.users.count > 0) errors.push(`Peak concurrent users (${a.users.peakConcurrent}) cannot exceed total users (${a.users.count}).`);
  const names = a.data.map((d) => d.source.trim().toLowerCase());
  if (new Set(names).size !== names.length) errors.push('Each data source should appear once.');
  if (a.constraints.regions.length && a.constraints.regions.some((r) => !/^[a-z0-9]{3,40}$/.test(r))) errors.push('Regions must be Azure region names such as centralindia.');
  return errors;
}

/** Combines the answers and a classification (or an override) into the stored UseCaseSpec. */
export function buildUseCaseSpec(
  a: IntakeAnswers,
  c: Classification,
  owner: string,
  override?: { pattern: SolutionPattern; reason: string; by: string },
): UseCaseSpec {
  const chosen = override?.pattern ?? c.pattern;
  return {
    ...a,
    owner,
    pattern: {
      id: chosen,
      confidence: override ? 1 : c.confidence,
      rationale: override ? `Overridden by ${override.by}: ${override.reason}` : c.rationale,
      overriddenBy: override?.by ?? null,
      overrideReason: override?.reason ?? null,
      classifiedAs: c.pattern,
      missingInfo: c.missingInfo,
      riskClass: c.riskClass,
      supportedInMvp: SOLUTION_PATTERNS.find((p) => p.id === chosen)!.mvp,
    },
  };
}
