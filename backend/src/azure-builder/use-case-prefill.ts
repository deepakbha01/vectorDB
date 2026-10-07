import { IntakeAnswers, TargetEnvironment } from './use-case-spec';

/** The parts of an Evectorize Discovery assessment the intake can reuse. */
export interface DiscoveryForPrefill {
  environment?: string;
  documentCount?: number;
  avgDocumentSizeKb?: number;
  concurrentUsers?: number;
  targetP95LatencyMs?: number;
  availabilityTargetPercent?: number;
  monthlyBudgetUsd?: number | null;
  containsPii?: boolean;
  regulatoryRequirements?: string | null;
  dataResidencyRequirement?: string | null;
}

export interface PrefillResult {
  answers: IntakeAnswers;
  /** Field -> where its value came from, shown next to the field so nothing looks invented. */
  sources: Record<string, string>;
}

const ENV: Record<string, TargetEnvironment> = { development: 'dev', staging: 'test', production: 'prod' };

/**
 * Seeds the intake wizard from what the project already knows - its name and
 * business use case, the Phase 0 connection and the Evectorize Discovery
 * assessment - so nothing is asked twice. Every value stays editable; anything
 * not known is left blank for the classifier to report as missing.
 */
export function prefillIntake(
  project: { name: string; businessUseCase?: string | null },
  connection: { region: string } | null,
  discovery: DiscoveryForPrefill | null,
): PrefillResult {
  const sources: Record<string, string> = {};
  const from = (field: string, source: string) => { sources[field] = source; };

  const answers: IntakeAnswers = {
    name: project.name,
    business: { problem: project.businessUseCase?.trim() ?? '', kpis: [], sponsor: '', costCenter: '' },
    users: { type: 'internal', count: 0, peakConcurrent: 0, channels: [] },
    data: [],
    constraints: { regions: [], dataResidency: null, compliance: [], latencyMs: null, availability: null, monthlyBudgetUsd: null },
    environment: 'dev',
  };
  from('name', 'Project name');
  if (answers.business.problem) from('business.problem', 'Project business use case');

  if (connection) {
    answers.constraints.regions = [connection.region];
    from('constraints.regions', 'Azure Builder Phase 0 connection');
  }

  if (discovery) {
    const d = discovery;
    if (d.environment && ENV[d.environment]) { answers.environment = ENV[d.environment]; from('environment', 'Discovery environment'); }
    if (d.concurrentUsers) {
      answers.users.peakConcurrent = d.concurrentUsers;
      answers.users.count = d.concurrentUsers * 10; // a common 10:1 named-to-concurrent ratio - flagged as an estimate
      from('users.peakConcurrent', 'Discovery concurrent users');
      from('users.count', 'Estimated as 10 x Discovery concurrent users - confirm');
    }
    if (d.documentCount && d.avgDocumentSizeKb) {
      answers.data.push({
        source: 'Document corpus (from Discovery)',
        format: 'documents',
        volumeGb: Number(((d.documentCount * d.avgDocumentSizeKb) / (1024 * 1024)).toFixed(2)),
        classification: d.containsPii ? 'confidential' : 'internal',
        containsPersonalData: !!d.containsPii,
        refresh: 'daily',
      });
      from('data', 'Discovery document count x average size; PII flag');
    }
    if (d.regulatoryRequirements?.trim()) {
      answers.constraints.compliance = d.regulatoryRequirements.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      from('constraints.compliance', 'Discovery regulatory requirements');
    }
    if (d.dataResidencyRequirement?.trim()) { answers.constraints.dataResidency = d.dataResidencyRequirement.trim(); from('constraints.dataResidency', 'Discovery data residency'); }
    if (d.targetP95LatencyMs) { answers.constraints.latencyMs = d.targetP95LatencyMs; from('constraints.latencyMs', 'Discovery P95 latency target'); }
    if (d.availabilityTargetPercent) { answers.constraints.availability = String(d.availabilityTargetPercent); from('constraints.availability', 'Discovery availability target'); }
    if (d.monthlyBudgetUsd != null) { answers.constraints.monthlyBudgetUsd = d.monthlyBudgetUsd; from('constraints.monthlyBudgetUsd', 'Discovery monthly budget'); }
  }
  return { answers, sources };
}
