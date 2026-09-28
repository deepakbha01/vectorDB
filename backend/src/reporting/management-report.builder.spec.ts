import { buildManagementReport } from './management-report.builder';
import { PhaseStatus, ProjectPhase } from '../projects/enums/project-status.enum';

const allStatuses = (status: PhaseStatus) => Object.fromEntries(Object.values(ProjectPhase).map((p) => [p, status]));

const project: any = { name: 'RAG Assistant', customerMode: 'new', platform: 'undetermined', phaseStatuses: allStatuses(PhaseStatus.NOT_STARTED) };

const discovery: any = {
  estimatedVectorCount: 5_000_000,
  qps: 50,
  peakQps: 200,
  targetP95LatencyMs: 100,
  recallTarget: 0.95,
  environment: 'production',
  availabilityTargetPercent: 99.9,
  rpoMinutes: 15,
  rtoMinutes: 60,
  monthlyBudgetUsd: 1000,
  containsPii: true,
  requiresEncryptionAtRest: true,
  requiresEncryptionInTransit: true,
  requiresTenantIsolation: false,
  requiresAuditLogging: true,
  tenancyModel: 'single',
  createdAt: new Date('2026-09-01'),
};

const adr: any = {
  decision: 'qdrant',
  confidence: 'medium',
  decisionStatus: 'conditional',
  operationalComplexity: 'moderate',
  rationale: 'Best fit.',
  plainLanguageSummary: { bottomLine: 'Proceed with Qdrant after a benchmark.' },
  openValidations: ['Benchmark recall on production data'],
  budgetFeasibility: { monthlyBudgetUsd: 1000, estimatedMonthlyCostUsd: 1400, status: 'exceeds_budget', note: '' },
  complianceGate: { status: 'unverified' },
  risks: [
    { id: 'R1', description: 'Low-risk item', impact: 'low', likelihood: 'low', mitigation: 'Monitor', status: 'open' },
    { id: 'R2', description: 'Recall below target', impact: 'high', likelihood: 'medium', mitigation: 'Tune ef', status: 'open', owner: 'Architect' },
    { id: 'R3', description: 'Closed risk', impact: 'high', likelihood: 'high', mitigation: '-', status: 'closed' },
  ],
  createdAt: new Date('2026-09-10'),
};

function table(doc: ReturnType<typeof buildManagementReport>, heading: string) {
  const section = doc.sections.find((s) => s.heading === heading);
  return section?.tables?.[0];
}

/** Executive Summary as { area: [position, text] }. */
function executive(doc: ReturnType<typeof buildManagementReport>): Record<string, [string, string]> {
  return Object.fromEntries(table(doc, 'Executive Summary')!.rows.map((r) => [r[0], [r[1], r[2]]]));
}

const tuned = (p95: number, recall: number, qps: number): any => ({
  recommendedVariant: { p95LatencyMs: p95, avgRecall: recall, achievedQps: qps },
  costImplications: { estimatedCostPerHourUsd: 10 },
});

/** Mirrors the AutoAI Factory assessment the executive-summary recommendation was written against. */
const autoAi = {
  project: { ...project, name: 'AutoAI Factory', platform: 'postgres_pgvector', phaseStatuses: allStatuses(PhaseStatus.COMPLETED) },
  parts: {
    discovery: { ...discovery, targetP95LatencyMs: 150, recallTarget: 0.9, peakQps: 60, monthlyBudgetUsd: null },
    adr: { ...adr, decision: 'postgres_pgvector', confidence: 'high', decisionStatus: 'single', budgetFeasibility: null, risks: [adr.risks[0]] },
    optimizationReport: tuned(37, 1, 28.75),
    capacityPlan: { forecast: [{ horizonMonths: 24, projectedVectorCount: 1_000_000, estimatedMemoryGb: 12 }], shardingRecommendation: { strategy: 'Vertical scaling' } } as any,
    finops: { chosen: { id: 'chosen', label: 'Chosen design (GCP)', monthlyUsd: 7289, byCategory: null }, oneOff: [], budget: { monthlyBudgetUsd: null, status: 'no_budget' } } as any,
  },
};

describe('buildManagementReport', () => {
  it('renders every section as tables, even for a project with nothing assessed', () => {
    const doc = buildManagementReport(project, {});

    expect(doc.title).toBe('Management Report - Assessment Summary');
    const scorecard = table(doc, 'Assessment scorecard')!;
    expect(scorecard.rows).toHaveLength(Object.values(ProjectPhase).length);
    expect(scorecard.headers).toEqual(['Phase', 'Status', 'Key outcome']);
    expect(scorecard.rows[0]).toEqual(['1. Discovery', 'Not started', 'Not yet assessed']);
    expect(executive(doc)['Overall readiness'][0]).toBe('Red – Assessment Incomplete');
    expect(executive(doc)['Recommended architecture'][1]).toContain('has not yet been recommended');
    // every row in every table has one cell per header
    for (const section of doc.sections) {
      for (const t of section.tables ?? []) {
        for (const row of t.rows) expect(row).toHaveLength(t.headers.length);
      }
    }
  });

  describe('Executive Summary', () => {
    it('follows the executive layout, in order', () => {
      const t = table(buildManagementReport(autoAi.project, autoAi.parts), 'Executive Summary')!;
      expect(t.headers).toEqual(['Area', 'Position', 'Executive summary']);
      expect(t.rows.map((r) => r[0])).toEqual([
        'Overall readiness',
        'Recommended architecture',
        'Decision confidence',
        'Assessment status',
        'Performance outcome',
        'Risk position',
        'Capacity and scalability',
        'Estimated monthly run cost',
        'Executive recommendation',
        'Management conditions',
      ]);
    });

    it('gives Conditional Approval when a target or the budget remains open (the AutoAI Factory case)', () => {
      const e = executive(buildManagementReport(autoAi.project, autoAi.parts));

      expect(e['Overall readiness']).toEqual([
        'Amber – On Track',
        'Overall readiness is Amber – On Track. All assessment phases are complete and no high-impact risks have been identified. ' +
          'The remaining focus is closure of the identified throughput gap and confirmation of the operating budget before final production approval.',
      ]);
      expect(e['Recommended architecture'][0]).toBe('PostgreSQL + pgvector');
      expect(e['Recommended architecture'][1]).toContain('with high decision confidence. The selected architecture demonstrates strong alignment');
      expect(e['Decision confidence'][0]).toBe('High');
      expect(e['Assessment status']).toEqual([
        '8 of 8 phases completed',
        'The AutoAI Factory assessment has been completed across all eight assessment phases, covering workload requirements, data and embedding strategy, ' +
          'index design, vector platform selection, infrastructure, ingestion, optimization, and capacity planning.',
      ]);
      expect(e['Performance outcome']).toEqual([
        'Latency and recall targets achieved; peak throughput requires closure.',
        'The assessment demonstrates strong search performance, with latency and recall targets achieved. ' +
          'Peak throughput remains the primary performance gap, with the current benchmark below the defined peak workload requirement.',
      ]);
      expect(e['Risk position'][0]).toBe('No high-impact risks identified.');
      expect(e['Capacity and scalability'][1]).toContain('including a 24-month growth outlook and a defined scaling strategy');
      expect(e['Estimated monthly run cost'][0]).toBe('$7,289*');
      expect(e['Estimated monthly run cost'][1]).toContain('No formal budget has been specified in the assessment');
      expect(e['Executive recommendation']).toEqual([
        'Conditional Approval',
        'Proceed with PostgreSQL + pgvector as the recommended vector platform for the assessed workload. Before final production approval, ' +
          'close the peak-throughput gap and confirm the operating budget. Once these management conditions are satisfied, the architecture can proceed toward production readiness.',
      ]);
      expect(e['Management conditions']).toEqual([
        '2 conditions',
        '1. Close the peak-throughput gap. 2. Confirm the operating budget. 3. Proceed to production readiness after closure.',
      ]);
    });

    it('keeps technical detail out of the Executive Summary', () => {
      const text = table(buildManagementReport(autoAi.project, autoAi.parts), 'Executive Summary')!.rows.flat().join(' ');
      for (const detail of ['HNSW', 'dims', 'chunking', 'GB', '28.75', '37ms', 'vectors']) expect(text).not.toContain(detail);
    });

    it('gives Approved / Ready for Production when every target is met and nothing is open', () => {
      const parts = { ...autoAi.parts, optimizationReport: tuned(37, 1, 90), finops: { ...autoAi.parts.finops, budget: { monthlyBudgetUsd: 10000, status: 'within_budget' } } };
      const e = executive(buildManagementReport(autoAi.project, parts));
      expect(e['Executive recommendation'][0]).toBe('Approved / Ready for Production');
      expect(e['Overall readiness'][0]).toBe('Green – Ready');
      expect(e['Management conditions']).toEqual(['None', 'No outstanding management conditions.']);
      expect(e['Estimated monthly run cost'][1]).toContain('within the stated monthly budget of $10,000');
    });

    it('gives Reassessment Required when recall or latency fails, since that needs the architecture revisited', () => {
      const e = executive(buildManagementReport(autoAi.project, { ...autoAi.parts, optimizationReport: tuned(37, 0.8, 90) }));
      expect(e['Executive recommendation'][0]).toBe('Reassessment Required');
      expect(e['Executive recommendation'][1]).toContain('the recall requirement is not met');
      expect(e['Overall readiness'][0]).toBe('Red – Reassessment Required');
    });

    it('lists open high-impact risks, a budget breach and missing phases as conditions', () => {
      const partial = { ...autoAi.project, phaseStatuses: { ...allStatuses(PhaseStatus.COMPLETED), [ProjectPhase.CAPACITY]: PhaseStatus.IN_PROGRESS } };
      const parts = { ...autoAi.parts, adr: { ...autoAi.parts.adr, risks: adr.risks }, finops: { ...autoAi.parts.finops, budget: { monthlyBudgetUsd: 5000, status: 'exceeds_budget' } } };
      const e = executive(buildManagementReport(partial, parts));
      expect(e['Management conditions'][1]).toBe(
        '1. Close the peak-throughput gap. 2. Approve additional budget or reduce scope. 3. Mitigate the 1 open high-impact risk. ' +
          '4. Complete the outstanding assessment phases: Capacity. 5. Proceed to production readiness after closure.',
      );
      expect(e['Risk position'][0]).toBe('1 open high-impact risk.');
      expect(e['Assessment status'][0]).toBe('7 of 8 phases completed');
    });
  });

  it('puts the budget breach and open validations in the management actions', () => {
    const actions = table(buildManagementReport(project, { discovery, adr }), 'Management actions and decisions required')!.rows.map((r) => r[2]);
    expect(actions[0]).toBe('Approve additional budget or reduce scope');
    expect(actions).toContain('Benchmark recall on production data');
    expect(actions).toContain('Assign an owner to mitigate: Recall below target');
  });

  it('ranks open risks by impact x likelihood and leaves closed ones out', () => {
    const risks = table(buildManagementReport(project, { discovery, adr }), 'Top risks')!.rows;
    expect(risks.map((r) => r[0])).toEqual(['Recall below target', 'Low-risk item']);
    expect(risks[0][4]).toBe('Architect');
    expect(risks[1][4]).toBe('Unassigned');
  });

  it('judges performance against the Discovery targets using the tuned benchmark', () => {
    const rows = table(buildManagementReport(project, { discovery, optimizationReport: tuned(80, 0.93, 250) }), 'Performance against targets')!.rows;
    expect(rows[0]).toEqual(['P95 latency', '<= 100ms', '80ms', 'Met']);
    expect(rows[1]).toEqual(['Recall', '>= 0.95', '0.93', 'Not met']);
    expect(rows[2]).toEqual(['Throughput (QPS)', '>= 200 peak', '250', 'Met']);
  });

  it('asks management to close a missed target and to set a budget', () => {
    const done = { ...project, phaseStatuses: allStatuses(PhaseStatus.COMPLETED) };
    const doc = buildManagementReport(done, { discovery: { ...discovery, monthlyBudgetUsd: null }, optimizationReport: tuned(80, 0.99, 30) });
    const actions = table(doc, 'Management actions and decisions required')!.rows.map((r) => r[2]);
    expect(actions[0]).toBe('Close the Throughput (QPS) gap (target >= 200 peak, achieved 30)');
    expect(actions).toContain('Set a monthly budget against the $7,300* estimate');
  });

  it('marks every estimated cost with * and explains it under each table that shows one', () => {
    const finops: any = {
      chosen: { id: 'chosen', label: 'Chosen design (GCP)', monthlyUsd: 7289, byCategory: { inference: 5542, vector_db: 107 } },
      cheapestAllowed: { id: 'onprem', label: 'On-premises', monthlyUsd: 6233 },
      oneOff: [{ usd: 53 }],
      budget: { monthlyBudgetUsd: 10000, status: 'within_budget' },
    };
    const doc = buildManagementReport(project, { discovery, adr, finops });

    const cost = table(doc, 'Cost and budget')!;
    const amounts = Object.fromEntries(cost.rows.map((r) => [r[0], r[1]]));
    expect(amounts['Approved / stated monthly budget']).toBe('$10,000');
    expect(amounts['Run cost - Inference']).toBe('$5,542*');
    expect(amounts['Estimated total run cost (monthly)']).toBe('$7,289*');
    expect(amounts['One-off implementation cost']).toBe('$53*');
    expect(amounts['Lowest-cost alternative (On-premises)']).toBe('$6,233*');
    expect(cost.footnote).toContain('the Qdrant platform selection and the "Chosen design (GCP)" deployment');
    expect(table(doc, 'Executive Summary')!.footnote).toBe(cost.footnote);
    expect(table(doc, 'Assessment scorecard')!.footnote).toBeUndefined();
  });
});
