import { Project } from '../projects/project.entity';
import { PhaseStatus, ProjectPhase } from '../projects/enums/project-status.enum';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { DiscoveryAssessment } from '../discovery/discovery-assessment.entity';
import { ArchitectureDecisionRecord } from '../vector-db-selection/architecture-decision-record.entity';
import { DataPipelineDesign } from '../data-pipeline/data-pipeline-design.entity';
import { IndexDesign } from '../index-design/index-design.entity';
import { DeploymentPlan } from '../deployment/deployment-plan.entity';
import { OptimizationReport } from '../benchmark/optimization-report.entity';
import { CapacityPlan } from '../capacity-planning/capacity-plan.entity';
import { RiskEntry, RiskSeverity } from '../recommendation-engine/recommendation.types';
import { FinalResult, StageStatus } from '../ai-factory/final/final.types';
import { FinopsResult } from '../ai-factory/finops/finops.types';
import { ReportDocument, ReportSection } from './report-document.types';

/** Everything the Management Report can draw on - every part is optional, a partly assessed project still gets a report. */
export interface ManagementReportParts {
  discovery?: DiscoveryAssessment;
  adr?: ArchitectureDecisionRecord;
  dataPipeline?: DataPipelineDesign;
  indexDesign?: IndexDesign;
  deploymentPlan?: DeploymentPlan;
  optimizationReport?: OptimizationReport;
  capacityPlan?: CapacityPlan;
  /** AI Factory - only passed when AI_FACTORY_ENABLED is on. */
  finalRecommendation?: FinalResult;
  finops?: FinopsResult;
}

const HOURS_PER_MONTH = 730;
const MAX_RISKS = 8;
const NOT_AVAILABLE = 'Not yet assessed';

const PHASE_LABEL: Record<ProjectPhase, string> = {
  [ProjectPhase.DISCOVERY]: '1. Discovery',
  [ProjectPhase.DATA_EMBEDDINGS]: '2. Data & Embeddings',
  [ProjectPhase.INDEX_DESIGN]: '3. Index Design',
  [ProjectPhase.VECTOR_DB_SELECTION]: '4. Vector DB Selection',
  [ProjectPhase.INFRASTRUCTURE]: '5. Infrastructure',
  [ProjectPhase.INGESTION]: '6. Ingestion',
  [ProjectPhase.OPTIMIZATION]: '7. Optimization',
  [ProjectPhase.CAPACITY]: '8. Capacity',
};

const STATUS_LABEL: Record<PhaseStatus, string> = {
  [PhaseStatus.NOT_STARTED]: 'Not started',
  [PhaseStatus.IN_PROGRESS]: 'In progress',
  [PhaseStatus.COMPLETED]: 'Completed',
  [PhaseStatus.VALIDATED]: 'Validated',
};

const STAGE_LABEL: Record<StageStatus, string> = {
  pass: 'Pass',
  pass_with_conditions: 'Pass with conditions',
  further_assessment: 'Further assessment',
  fail: 'Fail',
};

const SEVERITY_RANK: Record<RiskSeverity, number> = { high: 3, medium: 2, low: 1 };

function usd(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/** A cost the platform/deployment choice drives - marked * and explained by costFootnote(). */
function estimate(value: number): string {
  return `${usd(value)}*`;
}

const ESTIMATE_MARK = /\$[\d,]+\*/;

/** Names the platform and deployment the figures assume, so a reader knows what would move them. */
function costFootnote(project: Project, parts: ManagementReportParts): string {
  const platform = platformName(project, parts) ?? 'current';
  const deployment = parts.finops?.chosen?.label ?? parts.finalRecommendation?.executiveSummary.deployment ?? null;
  const basis = deployment ? `the ${platform} platform selection and the "${deployment}" deployment` : `the ${platform} platform selection`;
  return (
    `* Estimated cost, based on ${basis} in this report. It can change with a different platform selection or ` +
    'deployment model (cloud provider, region, on-premises, sizing, pricing). Validate against the Vector DB Selection ' +
    'and Cost Recommendation before approving budget.'
  );
}

function title(text: string): string {
  const spaced = text.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}


function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}

const PLATFORM_NAME: Record<VectorPlatform, string> = {
  [VectorPlatform.UNDETERMINED]: 'Not yet selected',
  [VectorPlatform.ORACLE]: 'Oracle Database',
  [VectorPlatform.POSTGRES_PGVECTOR]: 'PostgreSQL + pgvector',
  [VectorPlatform.MILVUS]: 'Milvus',
  [VectorPlatform.PINECONE]: 'Pinecone',
  [VectorPlatform.QDRANT]: 'Qdrant',
  [VectorPlatform.WEAVIATE]: 'Weaviate',
  [VectorPlatform.CHROMA]: 'Chroma',
  [VectorPlatform.ELASTICSEARCH]: 'Elasticsearch / OpenSearch',
  [VectorPlatform.REDIS]: 'Redis',
  [VectorPlatform.MONGODB_ATLAS]: 'MongoDB Atlas',
  [VectorPlatform.LANCEDB]: 'LanceDB',
  [VectorPlatform.ACTIAN]: 'Actian',
};

/** The recommended platform's display name, or null while no platform has been selected. */
function platformName(project: Project, parts: ManagementReportParts): string | null {
  const id = parts.adr?.decision ?? (project.platform !== VectorPlatform.UNDETERMINED ? project.platform : null);
  return id ? PLATFORM_NAME[id as VectorPlatform] ?? id : null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "a", "a and b", "a, b and c" */
function joinAnd(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const NUMBER_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** Performance-table metric -> how the executive summary names it. */
const METRIC_PHRASE: Record<string, { name: string; gap: string; focus: string }> = {
  'P95 latency': { name: 'latency', gap: 'latency', focus: 'the identified latency gap' },
  Recall: { name: 'recall', gap: 'recall', focus: 'the identified recall gap' },
  'Throughput (QPS)': { name: 'peak throughput', gap: 'peak-throughput', focus: 'the identified throughput gap' },
};

/** Latency and recall are fixed by the platform/index design; throughput can be closed by scaling, so only these force a reassessment. */
const ARCHITECTURE_CRITICAL = ['P95 latency', 'Recall'];

export type ExecutiveVerdict = 'Approved / Ready for Production' | 'Conditional Approval' | 'Reassessment Required';

interface ManagementCondition {
  /** Imperative, for the numbered conditions list: "Close the peak-throughput gap." */
  action: string;
  /** Noun phrase, for the readiness sentence: "closure of the identified throughput gap". */
  focus: string;
}

function phaseCompletion(project: Project): { done: number; total: number; outstanding: string[] } {
  const phases = Object.values(ProjectPhase);
  const complete = (s?: PhaseStatus) => s === PhaseStatus.COMPLETED || s === PhaseStatus.VALIDATED;
  const outstanding = phases.filter((p) => !complete(project.phaseStatuses?.[p])).map((p) => PHASE_LABEL[p].replace(/^\d+\. /, ''));
  return { done: phases.length - outstanding.length, total: phases.length, outstanding };
}

/**
 * Executive Summary engine: turns the assessment results into concise,
 * decision-oriented language (what was assessed, what is recommended, the
 * outcome, the evidence, and what management still has to do). Nothing is
 * hard-coded to a project - every sentence is chosen from the results - and
 * no technical detail is repeated; that stays in the sections below.
 */
function executiveSummary(project: Project, parts: ManagementReportParts, performance: string[][]): { rows: string[][]; verdict: ExecutiveVerdict } {
  const platform = platformName(project, parts);
  const confidence = parts.finalRecommendation?.executiveSummary.confidence ?? parts.adr?.confidence ?? null;
  const phases = phaseCompletion(project);
  const allPhasesDone = phases.outstanding.length === 0;
  const openHighRisks = (parts.adr?.risks ?? []).filter((r) => r.impact === 'high' && r.status === 'open').length;

  const measured = performance.filter((row) => row[3] === 'Met' || row[3] === 'Not met');
  const met = measured.filter((row) => row[3] === 'Met').map((row) => row[0]);
  const notMet = measured.filter((row) => row[3] === 'Not met').map((row) => row[0]);
  const phrase = (metric: string) => METRIC_PHRASE[metric]?.name ?? metric.toLowerCase();

  // Management conditions - what stands between this assessment and production approval.
  const conditions: ManagementCondition[] = [];
  for (const metric of notMet) {
    const p = METRIC_PHRASE[metric] ?? { gap: metric.toLowerCase(), focus: `the ${metric.toLowerCase()} gap` };
    conditions.push({ action: `Close the ${p.gap} gap.`, focus: `closure of ${p.focus}` });
  }
  const budget = statedBudget(parts);
  const budgetState = budgetStatus(parts).toLowerCase();
  const cost = estimatedMonthlyCost(parts);
  if (budget == null) {
    conditions.push({ action: 'Confirm the operating budget.', focus: 'confirmation of the operating budget' });
  } else if (budgetState.startsWith('exceeds')) {
    conditions.push({ action: 'Approve additional budget or reduce scope.', focus: 'resolution of the budget shortfall' });
  }
  if (openHighRisks > 0) {
    conditions.push({ action: `Mitigate the ${openHighRisks} open high-impact risk${openHighRisks > 1 ? 's' : ''}.`, focus: 'mitigation of the open high-impact risks' });
  }
  if (parts.adr?.decisionStatus === 'conditional') {
    conditions.push({ action: 'Close the open platform validations.', focus: 'closure of the open platform validations' });
  }
  if (benchmarkNotRepresentative(parts)) {
    conditions.push({ action: 'Install pgvector on the target database and re-run the Optimization benchmark.', focus: 'a representative benchmark with pgvector installed' });
  }
  if (!allPhasesDone) {
    conditions.push({ action: `Complete the outstanding assessment phases: ${joinAnd(phases.outstanding)}.`, focus: 'completion of the outstanding assessment phases' });
  }
  const finalStatus = parts.finalRecommendation?.readiness.status;
  if (finalStatus === 'ready_with_conditions' || finalStatus === 'further_assessment') {
    conditions.push({ action: 'Resolve the Final Recommendation readiness conditions.', focus: 'resolution of the readiness gate conditions' });
  }

  // Decision logic.
  const criticalFailures = notMet.filter((m) => ARCHITECTURE_CRITICAL.includes(m));
  const verdict: ExecutiveVerdict =
    finalStatus === 'not_suitable' || criticalFailures.length > 0
      ? 'Reassessment Required'
      : conditions.length === 0 && platform
        ? 'Approved / Ready for Production'
        : 'Conditional Approval';

  // Overall readiness (Amber is "on track with closure items", never a failure).
  let readiness: string;
  let readinessText: string;
  const phasesSentence = allPhasesDone ? 'All assessment phases are complete' : `${phases.done} of ${phases.total} assessment phases are complete`;
  const riskSentence = openHighRisks === 0 ? 'no high-impact risks have been identified' : `${openHighRisks} high-impact risk${openHighRisks > 1 ? 's remain' : ' remains'} open`;
  if (parts.finalRecommendation) {
    readiness = parts.finalRecommendation.readiness.label;
    readinessText = `Overall readiness is ${readiness}, as determined by the Final Recommendation readiness gate. ${phasesSentence} and ${riskSentence}.`;
  } else if (verdict === 'Reassessment Required') {
    readiness = 'Red – Reassessment Required';
    readinessText = `Overall readiness is ${readiness}. The ${joinAnd(criticalFailures.map(phrase))} target${criticalFailures.length > 1 ? 's are' : ' is'} not met by the recommended architecture, which requires the platform and index design to be revisited.`;
  } else if (verdict === 'Approved / Ready for Production') {
    readiness = 'Green – Ready';
    readinessText = `Overall readiness is ${readiness}. ${phasesSentence}, all measured targets are achieved and ${riskSentence}.`;
  } else if (phases.done < phases.total / 2) {
    readiness = 'Red – Assessment Incomplete';
    readinessText = `Overall readiness is ${readiness}. Only ${phases.done} of ${phases.total} assessment phases are complete, so an executive decision is premature.`;
  } else {
    readiness = 'Amber – On Track';
    readinessText = `Overall readiness is ${readiness}. ${phasesSentence} and ${riskSentence}. The remaining focus is ${joinAnd(conditions.map((c) => c.focus))} before final production approval.`;
  }

  // Assessment status.
  const totalWord = NUMBER_WORD[phases.total] ?? String(phases.total);
  const statusText = allPhasesDone
    ? `The ${project.name} assessment has been completed across all ${totalWord} assessment phases, covering workload requirements, data and embedding strategy, index design, vector platform selection, infrastructure, ingestion, optimization, and capacity planning.`
    : `The ${project.name} assessment has completed ${phases.done} of ${phases.total} phases. Outstanding: ${joinAnd(phases.outstanding)}.`;

  // Recommended architecture and confidence.
  const architectureText = !platform
    ? 'A vector platform has not yet been recommended. Complete the Vector DB Selection to obtain a recommendation.'
    : `${platform} is the recommended vector platform for the assessed workload, with ${confidence ?? 'unrated'} decision confidence.` +
      (parts.adr?.decisionStatus === 'conditional'
        ? ' The recommendation is conditional on validations recorded in the Vector DB Selection.'
        : confidence === 'high'
          ? ' The selected architecture demonstrates strong alignment with the defined workload, search-quality, latency, operational, and infrastructure requirements.'
          : ' Some requirements are rated with lower confidence; see the Vector DB Selection for the evidence.');
  const decisionBasis: Record<string, string> = {
    single: 'a single clear recommendation',
    tied: 'a tie between candidates, resolved deterministically',
    conditional: 'a conditional recommendation',
  };
  const confidenceText = parts.adr
    ? `Based on the weighted Vector DB Selection scoring of all candidate platforms, which produced ${decisionBasis[parts.adr.decisionStatus] ?? 'a recommendation'}.`
    : 'Available once the Vector DB Selection has been run.';

  // Performance outcome - direction only; the figures stay in "Performance against targets".
  let performanceShort: string;
  let performanceText: string;
  if (!parts.discovery) {
    performanceShort = NOT_AVAILABLE;
    performanceText = 'Performance targets are captured in Discovery, which has not yet been submitted.';
  } else if (benchmarkNotRepresentative(parts)) {
    performanceShort = 'Not yet measured: the benchmark ran without pgvector.';
    performanceText =
      'The target database has no pgvector, so the Optimization benchmark compared every vector in the application instead of using ' +
      'the recommended index. Its latency, recall and throughput do not describe the proposed design; install pgvector on the target and re-run Optimization.';
  } else if (measured.length === 0) {
    performanceShort = 'Targets defined; not yet benchmarked.';
    performanceText = 'Performance targets are defined but have not yet been benchmarked; the Optimization phase provides the measured results.';
  } else {
    const metNames = met.map(phrase);
    const gapNames = notMet.map(phrase);
    performanceShort =
      gapNames.length === 0
        ? `${capitalize(joinAnd(metNames))} targets achieved.`
        : metNames.length === 0
          ? `${capitalize(joinAnd(gapNames))} ${gapNames.length > 1 ? 'require' : 'requires'} closure.`
          : `${capitalize(joinAnd(metNames))} target${metNames.length > 1 ? 's' : ''} achieved; ${joinAnd(gapNames)} ${gapNames.length > 1 ? 'require' : 'requires'} closure.`;
    const qualityMet = ARCHITECTURE_CRITICAL.every((m) => met.includes(m));
    const sentences: string[] = [];
    if (metNames.length > 0) {
      sentences.push(`${qualityMet ? 'The assessment demonstrates strong search performance, with' : 'The benchmark shows'} ${joinAnd(metNames)} target${metNames.length > 1 ? 's' : ''} achieved.`);
    }
    if (gapNames.length === 1) {
      sentences.push(`${capitalize(gapNames[0])} remains the primary performance gap, with the current benchmark below the defined ${notMet[0] === 'Throughput (QPS)' ? 'peak workload requirement' : 'target'}.`);
    } else if (gapNames.length > 1) {
      sentences.push(`${capitalize(joinAnd(gapNames))} remain below their defined targets in the current benchmark.`);
    }
    performanceText = sentences.join(' ');
  }

  // Risk position.
  const riskShort = !parts.adr ? NOT_AVAILABLE : openHighRisks === 0 ? 'No high-impact risks identified.' : `${openHighRisks} open high-impact risk${openHighRisks > 1 ? 's' : ''}.`;
  const riskText = !parts.adr
    ? 'The risk register is produced by the Vector DB Selection.'
    : openHighRisks === 0
      ? 'No high-impact risks are open in the risk register; remaining risks are listed under Top risks.'
      : 'High-impact risks require an owner and a mitigation before production approval; see Top risks.';

  // Capacity and scalability - existence of the plan only; the figures stay in the Capacity section.
  const horizon = parts.capacityPlan?.forecast[parts.capacityPlan.forecast.length - 1]?.horizonMonths;
  const capacityText = parts.capacityPlan
    ? `Capacity planning has been completed, including a ${horizon ? `${horizon}-month ` : ''}growth outlook and a defined scaling strategy. The detailed capacity and scaling assumptions are documented in the Capacity assessment.`
    : 'Capacity planning has not yet been completed.';

  // Cost position - never judged efficient/inefficient without a budget to compare against.
  let costText: string;
  if (cost.value === NOT_AVAILABLE) {
    costText = 'An operating cost estimate is not yet available.';
  } else {
    costText = `The estimated monthly operating cost for the selected design is approximately ${cost.value}.`;
    if (budget == null) {
      costText += " No formal budget has been specified in the assessment; therefore, financial approval remains subject to confirmation against the organization's target operating budget.";
    } else if (budgetState.startsWith('exceeds')) {
      costText += ` This exceeds the stated monthly budget of ${usd(budget)}; additional budget or a reduced scope must be approved.`;
    } else if (budgetState.startsWith('near')) {
      costText += ` This is close to the stated monthly budget of ${usd(budget)}.`;
    } else if (budgetState.startsWith('within')) {
      costText += ` This is within the stated monthly budget of ${usd(budget)}.`;
    } else {
      costText += ` The stated monthly budget is ${usd(budget)}; the estimate has not yet been confirmed against it.`;
    }
  }

  // Executive recommendation.
  const closing = conditions.map((c) => c.action.replace(/\.$/, '')).map((a) => a.charAt(0).toLowerCase() + a.slice(1));
  let recommendationText: string;
  if (!platform) {
    recommendationText = 'An executive decision is not yet possible: complete the Vector DB Selection to obtain a platform recommendation.';
  } else if (verdict === 'Reassessment Required') {
    recommendationText = criticalFailures.length > 0
      ? `Do not proceed to production with ${platform} as assessed: the ${joinAnd(criticalFailures.map(phrase))} requirement${criticalFailures.length > 1 ? 's are' : ' is'} not met. Reassess the platform and index design before resubmitting for approval.`
      : `The Final Recommendation rates this architecture as not suitable. Reassess the architecture before resubmitting for approval.`;
  } else if (verdict === 'Approved / Ready for Production') {
    recommendationText = `Proceed with ${platform} as the recommended vector platform for the assessed workload. All critical targets are met and no management conditions remain; the architecture is ready for production approval.`;
  } else {
    recommendationText = `Proceed with ${platform} as the recommended vector platform for the assessed workload. Before final production approval, ${joinAnd(closing)}. Once these management conditions are satisfied, the architecture can proceed toward production readiness.`;
  }

  // Management conditions, numbered, ending with the step they unlock.
  const conditionList = conditions.map((c) => c.action);
  if (conditionList.length > 0 && verdict === 'Conditional Approval') conditionList.push('Proceed to production readiness after closure.');
  const conditionsText = conditionList.length > 0 ? conditionList.map((c, i) => `${i + 1}. ${c}`).join(' ') : 'No outstanding management conditions.';

  return {
    verdict,
    rows: [
      ['Overall readiness', readiness, readinessText],
      ['Recommended architecture', platform ?? NOT_AVAILABLE, architectureText],
      ['Decision confidence', confidence ? capitalize(confidence) : NOT_AVAILABLE, confidenceText],
      ['Assessment status', `${phases.done} of ${phases.total} phases completed`, statusText],
      ['Performance outcome', performanceShort, performanceText],
      ['Risk position', riskShort, riskText],
      ['Capacity and scalability', parts.capacityPlan ? 'Completed' : NOT_AVAILABLE, capacityText],
      ['Estimated monthly run cost', cost.value, costText],
      ['Executive recommendation', verdict, recommendationText],
      ['Management conditions', conditions.length === 0 ? 'None' : `${conditions.length} condition${conditions.length > 1 ? 's' : ''}`, conditionsText],
    ],
  };
}

function estimatedMonthlyCost(parts: ManagementReportParts): { value: string; basis: string } {
  if (parts.finops?.chosen?.monthlyUsd != null) {
    return { value: estimate(parts.finops.chosen.monthlyUsd), basis: `AI Factory Cost Recommendation (${parts.finops.chosen.label})` };
  }
  const adrCost = parts.adr?.budgetFeasibility?.estimatedMonthlyCostUsd;
  if (adrCost != null) {
    return { value: estimate(adrCost), basis: 'Vector DB Selection budget feasibility' };
  }
  const perHour = parts.optimizationReport?.costImplications.estimatedCostPerHourUsd;
  if (perHour != null) {
    return { value: estimate(perHour * HOURS_PER_MONTH), basis: `Optimization Report ($${perHour}/hour x ${HOURS_PER_MONTH} hours)` };
  }
  return { value: NOT_AVAILABLE, basis: 'Run Vector DB Selection with a budget, Optimization or Cost Recommendation' };
}

function statedBudget(parts: ManagementReportParts): number | null {
  return parts.finops?.budget.monthlyBudgetUsd ?? parts.adr?.budgetFeasibility?.monthlyBudgetUsd ?? parts.discovery?.monthlyBudgetUsd ?? null;
}

function budgetStatus(parts: ManagementReportParts): string {
  if (statedBudget(parts) == null) return 'No budget specified';
  if (parts.finops && parts.finops.budget.status !== 'no_budget') return title(parts.finops.budget.status);
  if (parts.adr?.budgetFeasibility) return title(parts.adr.budgetFeasibility.status);
  return 'Not yet estimated';
}

function phaseOutcome(phase: ProjectPhase, parts: ManagementReportParts): string {
  const d = parts.discovery;
  switch (phase) {
    case ProjectPhase.DISCOVERY:
      return d ? `${d.estimatedVectorCount.toLocaleString()} vectors, ${d.qps} QPS (peak ${d.peakQps}), P95 target ${d.targetP95LatencyMs}ms, ${d.environment}` : NOT_AVAILABLE;
    case ProjectPhase.DATA_EMBEDDINGS:
      return parts.dataPipeline
        ? `${parts.dataPipeline.embeddingModelId} (${parts.dataPipeline.embeddingDimension} dims), ${parts.dataPipeline.chunkingStrategy} chunking`
        : NOT_AVAILABLE;
    case ProjectPhase.INDEX_DESIGN:
      return parts.indexDesign ? `${parts.indexDesign.label}, ~${parts.indexDesign.impact.memoryEstimateGb}GB memory` : NOT_AVAILABLE;
    case ProjectPhase.VECTOR_DB_SELECTION:
      return parts.adr ? `${PLATFORM_NAME[parts.adr.decision] ?? parts.adr.decision} selected (${parts.adr.confidence} confidence)` : NOT_AVAILABLE;
    case ProjectPhase.INFRASTRUCTURE:
      return parts.deploymentPlan
        ? `Deployment plan for ${PLATFORM_NAME[parts.deploymentPlan.platform as VectorPlatform] ?? parts.deploymentPlan.platform} - ${parts.deploymentPlan.executed ? 'executed' : 'not yet executed'}`
        : NOT_AVAILABLE;
    case ProjectPhase.OPTIMIZATION: {
      const v = parts.optimizationReport?.recommendedVariant;
      if (!v) return NOT_AVAILABLE;
      if (benchmarkNotRepresentative(parts)) return 'Ran without pgvector (exact scan) - results not representative; install pgvector and re-run';
      const throughput = v.sustainedQps != null ? `${v.sustainedQps} QPS with ${v.concurrency} parallel clients` : 'throughput not measured under load';
      return `Tuned: P95 ${v.p95LatencyMs}ms, recall ${v.avgRecall}, ${throughput}`;
    }
    case ProjectPhase.CAPACITY: {
      const last = parts.capacityPlan?.forecast[parts.capacityPlan.forecast.length - 1];
      return last && parts.capacityPlan
        ? `${last.horizonMonths}-month outlook: ${last.projectedVectorCount.toLocaleString()} vectors, ${last.estimatedMemoryGb.toFixed(0)}GB memory; ${parts.capacityPlan.shardingRecommendation.strategy}`
        : NOT_AVAILABLE;
    }
    default:
      return '-';
  }
}

const EXACT_SCAN_RESULT = 'Not representative - no pgvector on the target';

/** The latest benchmark ran as an exact scan (no pgvector), so it says nothing about the tuned index. */
function benchmarkNotRepresentative(parts: ManagementReportParts): boolean {
  return parts.optimizationReport?.searchMode === 'exact_scan';
}

/** Target vs achieved; "achieved" is the tuned benchmark when there is one, otherwise the design estimate. */
function performanceRows(parts: ManagementReportParts): string[][] {
  const d = parts.discovery;
  if (!d) return [];
  const judge = (met: boolean | null) => (met === null ? 'Not yet measured' : met ? 'Met' : 'Not met');
  if (benchmarkNotRepresentative(parts)) {
    return [
      ['P95 latency', `<= ${d.targetP95LatencyMs}ms`, EXACT_SCAN_RESULT, judge(null)],
      ['Recall', `>= ${d.recallTarget}`, EXACT_SCAN_RESULT, judge(null)],
      ['Throughput (QPS)', `>= ${d.peakQps} peak`, EXACT_SCAN_RESULT, judge(null)],
      ['Availability', `${d.availabilityTargetPercent}%`, parts.capacityPlan ? 'HA design in Capacity Plan' : '-', 'Design target'],
      ['RPO / RTO', `${d.rpoMinutes}min / ${d.rtoMinutes}min`, parts.capacityPlan ? 'DR design in Capacity Plan' : '-', 'Design target'],
    ];
  }
  const v = parts.optimizationReport?.recommendedVariant;
  return [
    ['P95 latency', `<= ${d.targetP95LatencyMs}ms`, v ? `${v.p95LatencyMs}ms` : parts.indexDesign?.impact.latencyEstimate ?? '-', judge(v ? v.p95LatencyMs <= d.targetP95LatencyMs : null)],
    ['Recall', `>= ${d.recallTarget}`, v ? String(v.avgRecall) : parts.indexDesign?.impact.recallEstimate ?? '-', judge(v ? v.avgRecall >= d.recallTarget : null)],
    // Only throughput under parallel load is comparable to a peak target; the one-at-a-time rate is ≈ 1 / latency.
    [
      'Throughput (QPS)',
      `>= ${d.peakQps} peak`,
      v?.sustainedQps != null ? `${v.sustainedQps} (${v.concurrency} parallel clients)` : v ? 'Not measured under load - re-run Optimization' : '-',
      judge(v?.sustainedQps != null ? v.sustainedQps >= d.peakQps : null),
    ],
    ['Availability', `${d.availabilityTargetPercent}%`, parts.capacityPlan ? 'HA design in Capacity Plan' : '-', 'Design target'],
    ['RPO / RTO', `${d.rpoMinutes}min / ${d.rtoMinutes}min`, parts.capacityPlan ? 'DR design in Capacity Plan' : '-', 'Design target'],
  ];
}

function costRows(parts: ManagementReportParts): string[][] {
  const rows: string[][] = [];
  const budget = statedBudget(parts);
  rows.push(['Approved / stated monthly budget', budget != null ? usd(budget) : 'Not specified', 'Discovery / Cost Recommendation']);
  const byCategory = parts.finops?.chosen?.byCategory;
  if (byCategory) {
    for (const [category, amount] of Object.entries(byCategory)) {
      if (amount > 0) rows.push([`Run cost - ${title(category)}`, estimate(amount), 'AI Factory Cost Recommendation']);
    }
  }
  const total = estimatedMonthlyCost(parts);
  rows.push(['Estimated total run cost (monthly)', total.value, total.basis]);
  const oneOff = (parts.finops?.oneOff ?? []).reduce((sum, c) => sum + c.usd, 0);
  if (oneOff > 0) rows.push(['One-off implementation cost', estimate(oneOff), 'AI Factory Cost Recommendation']);
  if (parts.finops?.cheapestAllowed && parts.finops.chosen && parts.finops.cheapestAllowed.id !== parts.finops.chosen.id) {
    rows.push([`Lowest-cost alternative (${parts.finops.cheapestAllowed.label})`, estimate(parts.finops.cheapestAllowed.monthlyUsd), 'For comparison']);
  }
  rows.push(['Budget status', budgetStatus(parts), '']);
  return rows;
}

function complianceRows(parts: ManagementReportParts): string[][] {
  const d = parts.discovery;
  if (!d) return [];
  const gate = parts.adr?.complianceGate;
  const gateStatus = gate ? title(gate.status) : 'Pending Vector DB Selection';
  return [
    ['Personal data (PII) in scope', yesNo(d.containsPii), d.containsPii ? gateStatus : 'Not applicable'],
    ['Encryption at rest', yesNo(d.requiresEncryptionAtRest), d.requiresEncryptionAtRest ? 'Required in design' : '-'],
    ['Encryption in transit', yesNo(d.requiresEncryptionInTransit), d.requiresEncryptionInTransit ? 'Required in design' : '-'],
    ['Tenant isolation', yesNo(d.requiresTenantIsolation), d.requiresTenantIsolation ? `Tenancy model: ${d.tenancyModel}` : '-'],
    ['Audit logging', yesNo(d.requiresAuditLogging), d.requiresAuditLogging ? 'Required in design' : '-'],
  ];
}

function topRisks(risks: RiskEntry[]): RiskEntry[] {
  return [...risks]
    .filter((r) => r.status !== 'closed')
    .sort((a, b) => SEVERITY_RANK[b.impact] * SEVERITY_RANK[b.likelihood] - SEVERITY_RANK[a.impact] * SEVERITY_RANK[a.likelihood])
    .slice(0, MAX_RISKS);
}

/** What management has to do or decide, highest priority first. */
function actionRows(project: Project, parts: ManagementReportParts, performance: string[][]): string[][] {
  const actions: Array<[string, string, string]> = [];
  const budget = budgetStatus(parts).toLowerCase();
  if (budget.startsWith('exceeds')) {
    actions.push(['High', 'Approve additional budget or reduce scope', 'Estimated run cost exceeds the stated budget']);
  }
  for (const [metric, target, achieved] of performance.filter((row) => row[3] === 'Not met')) {
    actions.push(['High', `Close the ${metric} gap (target ${target}, achieved ${achieved})`, 'Scale out, re-tune or accept a lower target before go-live']);
  }
  if (benchmarkNotRepresentative(parts)) {
    actions.push(['High', 'Install pgvector on the target database and re-run the Optimization benchmark', 'The benchmark ran as an exact scan, so latency, recall and throughput are not yet measured for the recommended index']);
  }
  if (statedBudget(parts) == null && estimatedMonthlyCost(parts).value !== NOT_AVAILABLE) {
    actions.push(['Medium', `Set a monthly budget against the ${estimatedMonthlyCost(parts).value} estimate`, 'No budget has been stated, so cost cannot be judged']);
  }
  for (const validation of parts.adr?.openValidations ?? []) {
    actions.push(['High', validation, 'Must be closed before the platform decision is final']);
  }
  for (const risk of (parts.adr?.risks ?? []).filter((r) => r.impact === 'high' && r.status === 'open')) {
    actions.push(['High', `Assign an owner to mitigate: ${risk.description}`, risk.mitigation]);
  }
  for (const gap of parts.finalRecommendation?.gaps ?? []) {
    actions.push(['Medium', gap, 'Gap reported by the Final Recommendation']);
  }
  for (const phase of Object.values(ProjectPhase)) {
    const status = project.phaseStatuses?.[phase];
    if (status === PhaseStatus.NOT_STARTED || status === PhaseStatus.IN_PROGRESS) {
      actions.push(['Medium', `Complete ${PHASE_LABEL[phase]}`, `Currently ${STATUS_LABEL[status].toLowerCase()}`]);
    }
  }
  if (actions.length === 0) {
    actions.push(['Low', 'Approve progression to implementation', 'All phases complete with no open blockers']);
  }
  const rank: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
  return actions
    .sort((a, b) => rank[a[0]] - rank[b[0]])
    .map(([priority, action, reason], i) => [String(i + 1), priority, action, reason]);
}

/**
 * Management Report: a few pages of tables answering "what did we
 * decide, is it ready, what will it cost, what could go wrong and what do you
 * need from me" - the detail stays in the per-phase reports.
 */
export function buildManagementReport(project: Project, parts: ManagementReportParts): ReportDocument {
  const performance = performanceRows(parts);
  const final = parts.finalRecommendation?.executiveSummary;
  const executive = executiveSummary(project, parts, performance);

  const sections: ReportSection[] = [
    {
      heading: 'Executive Summary',
      tables: [
        {
          headers: ['Area', 'Position', 'Executive summary'],
          rows: executive.rows,
        },
      ],
    },
    {
      heading: 'Assessment scorecard',
      tables: [
        {
          headers: ['Phase', 'Status', 'Key outcome'],
          rows: Object.values(ProjectPhase).map((phase) => [PHASE_LABEL[phase], STATUS_LABEL[project.phaseStatuses?.[phase] ?? PhaseStatus.NOT_STARTED], phaseOutcome(phase, parts)]),
        },
      ],
    },
    {
      heading: 'Key decisions',
      tables: [
        {
          headers: ['Decision area', 'Recommendation', 'Confidence / status'],
          rows: [
            ['Vector database', parts.adr ? PLATFORM_NAME[parts.adr.decision] ?? parts.adr.decision : NOT_AVAILABLE, parts.adr ? `${parts.adr.confidence} - ${parts.adr.decisionStatus}` : '-'],
            ['Index strategy', parts.indexDesign?.label ?? NOT_AVAILABLE, parts.indexDesign ? `rules v${parts.indexDesign.rulesVersion}` : '-'],
            ['Embedding model', parts.dataPipeline ? `${parts.dataPipeline.embeddingModelId} (${parts.dataPipeline.qualityTier} tier)` : NOT_AVAILABLE, parts.dataPipeline ? `$${parts.dataPipeline.costPerMillionTokens} per 1M tokens` : '-'],
            ['Scaling / sharding', parts.capacityPlan?.shardingRecommendation.strategy ?? NOT_AVAILABLE, '-'],
            ['Operational complexity', parts.adr?.operationalComplexity ?? NOT_AVAILABLE, '-'],
            ...(final
              ? [
                  ['Inference architecture', final.inferenceArchitecture, final.confidence],
                  ['Deployment model', final.deployment, final.confidence],
                ]
              : []),
          ],
        },
      ],
    },
  ];

  sections.push({
    heading: 'Performance against targets',
    tables: performance.length > 0 ? [{ headers: ['Metric', 'Target', 'Achieved / estimated', 'Status'], rows: performance }] : undefined,
    fields: performance.length === 0 ? [{ label: 'Status', value: 'Targets are captured in Discovery - not yet submitted.' }] : undefined,
  });

  sections.push({ heading: 'Cost and budget', tables: [{ headers: ['Item', 'Amount (USD)', 'Basis'], rows: costRows(parts) }] });

  const compliance = complianceRows(parts);
  if (compliance.length > 0) {
    sections.push({ heading: 'Security and compliance', tables: [{ headers: ['Control', 'Required', 'Status'], rows: compliance }] });
  }

  const risks = topRisks(parts.adr?.risks ?? []);
  const extraRisks = (parts.finalRecommendation?.executiveSummary.keyRisks ?? []).filter((k) => !risks.some((r) => r.description === k));
  if (risks.length > 0 || extraRisks.length > 0) {
    sections.push({
      heading: 'Top risks',
      tables: [
        {
          headers: ['Risk', 'Impact', 'Likelihood', 'Mitigation', 'Owner', 'Status'],
          rows: [
            ...risks.map((r) => [r.description, title(r.impact), title(r.likelihood), r.mitigation, r.owner ?? 'Unassigned', title(r.status)]),
            ...extraRisks.map((k) => [k, '-', '-', 'See Final Recommendation', 'Unassigned', 'Open']),
          ],
        },
      ],
    });
  }

  if (parts.finalRecommendation) {
    sections.push({
      heading: 'Production readiness gate',
      tables: [
        {
          headers: ['Gate', 'Result', 'Reason'],
          rows: parts.finalRecommendation.readiness.stages.map((s) => [s.label, STAGE_LABEL[s.status], s.reasons.join(' ') || '-']),
        },
      ],
    });
  }

  sections.push({ heading: 'Management actions and decisions required', tables: [{ headers: ['#', 'Priority', 'Action', 'Reason'], rows: actionRows(project, parts, performance) }] });

  // Every table that shows a * cost gets the same explanation underneath it.
  const footnote = costFootnote(project, parts);
  for (const table of sections.flatMap((s) => s.tables ?? [])) {
    if (table.rows.some((row) => row.some((cell) => ESTIMATE_MARK.test(cell)))) table.footnote = footnote;
  }

  return {
    title: 'Management Report - Assessment Summary',
    subtitle: project.name,
    generatedAt: new Date().toISOString(),
    sections,
  };
}
