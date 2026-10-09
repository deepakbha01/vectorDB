import { assessRisk, buildUseCaseSpec, classifyUseCase, findMissingInfo, IntakeAnswers, SOLUTION_PATTERNS, validateIntake } from './use-case-spec';

const base: IntakeAnswers = {
  name: 'Use case',
  business: { problem: 'A problem statement that is long enough to pass the check here', kpis: ['KPI'], sponsor: 'Sponsor', costCenter: 'CC-1' },
  users: { type: 'internal', count: 1000, peakConcurrent: 50, channels: ['web'] },
  data: [{ source: 'Source', format: 'text', volumeGb: 5, classification: 'internal', containsPersonalData: false, refresh: 'daily' }],
  constraints: { regions: ['centralindia'], dataResidency: null, compliance: [], latencyMs: 3000, availability: '99.9', monthlyBudgetUsd: 2000 },
  environment: 'dev',
};
const withText = (name: string, problem: string, extra: Partial<IntakeAnswers> = {}): IntakeAnswers => ({ ...base, name, business: { ...base.business, problem }, ...extra });

describe('classifyUseCase (spec 10.2 contract, deterministic)', () => {
  it.each([
    ['HR policy assistant', 'Employees ask questions about HR policies and need grounded answers with citations from the handbook', 'rag-assistant', { data: [{ ...base.data[0], source: 'SharePoint', format: 'pdf/docx' }] }],
    ['Ticket automation agent', 'Automate the multi-step workflow: read the request, call tools to update records in ServiceNow and trigger approvals', 'agentic-workflow', {}],
    ['Invoice processing', 'Extract fields from scanned supplier invoices and purchase orders into SAP', 'document-intelligence', { data: [{ ...base.data[0], source: 'Scanned invoices', format: 'pdf scan / tiff' }] }],
    ['Customer chat', 'A customer service chatbot on our website and in Teams to deflect helpdesk conversations', 'conversational-copilot', { users: { ...base.users, type: 'external' as const, channels: ['web' as const, 'teams' as const] } }],
    ['Demand forecasting', 'Forecast weekly demand and predict churn from tabular sales history in the warehouse', 'predictive-ml', { data: [{ ...base.data[0], source: 'Sales warehouse', format: 'sql tables' }] }],
  ])('classifies "%s" as %s', (name, problem, expected, extra) => {
    const c = classifyUseCase(withText(name, problem, extra as Partial<IntakeAnswers>));
    expect(c.pattern).toBe(expected);
    expect(c.confidence).toBeGreaterThan(0.3);
    expect(c.rationale).toContain(SOLUTION_PATTERNS.find((p) => p.id === expected)!.label);
    expect(c.signals[c.pattern].length).toBeGreaterThan(0);
  });

  it('returns only the contract fields plus explainability, with a bounded confidence', () => {
    const c = classifyUseCase(withText('HR', 'Answer policy questions from documents'));
    expect(Object.keys(c).sort()).toEqual(['classifier', 'confidence', 'missingInfo', 'pattern', 'rationale', 'riskClass', 'riskReasons', 'scores', 'signals'].sort());
    expect(c.confidence).toBeGreaterThanOrEqual(0.05);
    expect(c.confidence).toBeLessThanOrEqual(0.99);
    expect(c.rationale.split(/\s+/).length).toBeLessThanOrEqual(61); // spec: max 60 words
  });

  it('defaults to the RAG assistant with low confidence when there is no evidence', () => {
    const c = classifyUseCase(withText('Project X', 'Something useful for the team', { data: [], users: { ...base.users, channels: [] } }));
    expect(c.pattern).toBe('rag-assistant');
    expect(c.confidence).toBeLessThanOrEqual(0.2);
    expect(c.rationale).toContain('No pattern evidence');
  });

  it('does not match keywords inside other words', () => {
    // "formal" must not count as "form"; "platform" must not count as "form" either
    const c = classifyUseCase(withText('Platform', 'A formal platform for the team to use every day', { data: [], users: { ...base.users, channels: [] } }));
    expect(c.signals['document-intelligence']).toEqual([]);
  });

  it('is deterministic', () => {
    const a = withText('HR policy assistant', 'Answer HR policy questions with citations');
    expect(classifyUseCase(a)).toEqual(classifyUseCase(a));
  });
});

describe('assessRisk (spec 10.2: high for personal or regulated data, or external users)', () => {
  it.each([
    [{ data: [{ ...base.data[0], containsPersonalData: true }] }, 'high', 'personal data'],
    [{ constraints: { ...base.constraints, compliance: ['DPDP'] } }, 'high', 'regulated (DPDP)'],
    [{ users: { ...base.users, type: 'external' as const } }, 'high', 'external users'],
    [{ data: [{ ...base.data[0], classification: 'restricted' as const }] }, 'high', 'restricted data'],
    [{ data: [{ ...base.data[0], classification: 'confidential' as const }] }, 'medium', 'confidential data'],
    [{}, 'low', 'internal users'],
  ])('%o -> %s', (extra, risk, reason) => {
    const r = assessRisk({ ...base, ...(extra as Partial<IntakeAnswers>) });
    expect(r.riskClass).toBe(risk);
    expect(r.reasons.join(' ')).toContain(reason);
  });
});

describe('findMissingInfo and validateIntake', () => {
  it('lists every gap instead of inventing values', () => {
    const gaps = findMissingInfo({
      ...base,
      business: { problem: 'Short one', kpis: [], sponsor: '', costCenter: '' },
      users: { type: 'internal', count: 0, peakConcurrent: 0, channels: [] },
      data: [],
      constraints: { regions: [], dataResidency: null, compliance: [], latencyMs: null, availability: null, monthlyBudgetUsd: null },
    });
    expect(gaps).toHaveLength(10);
    expect(gaps).toEqual(expect.arrayContaining(['Business sponsor', 'Cost center (needed for the mandatory costCenter tag)', 'Monthly budget']));
    expect(findMissingInfo(base)).toEqual([]);
  });

  it('rejects inconsistent answers', () => {
    expect(validateIntake({ ...base, users: { ...base.users, count: 10, peakConcurrent: 50 } })[0]).toContain('cannot exceed total users');
    expect(validateIntake({ ...base, data: [base.data[0], { ...base.data[0], source: ' source ' }] })[0]).toContain('once');
    expect(validateIntake({ ...base, constraints: { ...base.constraints, regions: ['Central India'] } })[0]).toContain('region names');
    expect(validateIntake(base)).toEqual([]);
  });
});

describe('buildUseCaseSpec', () => {
  it('records the classification, or an override with who and why at full confidence', () => {
    const c = classifyUseCase(withText('HR', 'Answer HR policy questions from documents'));
    const plain = buildUseCaseSpec(base, c, 'owner@example.com');
    expect(plain.pattern).toMatchObject({ id: c.pattern, overriddenBy: null, supportedInMvp: true });
    const over = buildUseCaseSpec(base, c, 'owner@example.com', { pattern: 'predictive-ml', reason: 'It is a forecasting problem', by: 'architect@example.com' });
    expect(over.pattern).toMatchObject({ id: 'predictive-ml', classifiedAs: c.pattern, confidence: 1, overriddenBy: 'architect@example.com', supportedInMvp: false });
    expect(over.pattern.rationale).toContain('Overridden by architect@example.com');
  });
});

describe('classifyUseCase - RAG wording and the word "assistant"', () => {
  // Regression: this description was classified as a conversational copilot (2 vs 1.5) because "RAG",
  // "retrieving" and "evidence" were not RAG signals and "assistant" counted for the copilot only.
  const patient360 = withText(
    'Patient 360° AI Assistant',
    'Build an AI assistant that provides clinicians and care teams with a unified view of patient history by retrieving relevant clinical notes, diagnoses, medications, lab results, imaging summaries, and treatment history. The solution uses enterprise search, RAG, and contextual retrieval to provide evidence-based responses while maintaining privacy and compliance.',
    { users: { ...base.users, channels: ['web', 'teams', 'api', 'email'] as any } },
  );

  it('classifies an assistant described as retrieval / RAG over records as a RAG knowledge assistant', () => {
    const c = classifyUseCase(patient360);
    expect(c.pattern).toBe('rag-assistant');
    expect(c.signals['rag-assistant']).toEqual(expect.arrayContaining(['"rag"', '"retriev*"', '"evidence"', '"search"']));
    expect(c.scores['rag-assistant']).toBeGreaterThan(c.scores['conversational-copilot'] * 2);
  });

  it('treats "assistant" as evidence for both the RAG assistant and the copilot, not the copilot alone', () => {
    const c = classifyUseCase(withText('Sales assistant', 'An assistant for the sales team'));
    expect(c.scores['rag-assistant']).toBe(c.scores['conversational-copilot']);
    expect(c.signals['conversational-copilot']).toContain('"assistant"');
  });
});
