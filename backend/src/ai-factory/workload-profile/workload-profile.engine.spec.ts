import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { buildWorkloadProfile, classifySize, WorkloadProfileRules } from './workload-profile.engine';
import { resolveProfileInputs } from './workload-profile.service';
import { AiWorkloadType, BusinessCriticality, DataType, DeploymentTarget, ResolvedProfileInputs } from './workload-profile.types';
import { CreateWorkloadProfileDto } from './create-workload-profile.dto';

// The real rules from config/ai-factory.yaml, so the tests describe shipped behaviour.
const rules = (yaml.load(fs.readFileSync(path.join(__dirname, '../../../config/ai-factory.yaml'), 'utf8')) as any).workloadProfile as WorkloadProfileRules;

const project = { industry: 'Healthcare', businessUseCase: 'Clinical knowledge assistant' };
const discovery: any = {
  version: 4,
  documentCount: 200_000,
  estimatedVectorCount: 5_000_000,
  qps: 5,
  peakQps: 20,
  concurrentUsers: 300,
  documentGrowthPercentPerMonth: 3,
  availabilityTargetPercent: 99.9,
  hasGpu: false,
  containsPii: true,
  dataResidencyRequirement: 'EU',
  requiresEncryptionAtRest: true,
  requiresEncryptionInTransit: true,
  regulatoryRequirements: 'GDPR',
  deploymentEnvironment: 'cloud',
};
const base: CreateWorkloadProfileDto = {
  businessObjective: 'Answer clinician questions from guidelines',
  businessCriticality: BusinessCriticality.HIGH,
  workloadTypes: [AiWorkloadType.RAG],
  dataTypes: [DataType.DOCUMENTS],
  deploymentTargets: [DeploymentTarget.AZURE],
};
const profile = (dto: Partial<CreateWorkloadProfileDto> = {}, disc: any = discovery) => {
  const inputs = resolveProfileInputs({ ...base, ...dto }, disc, project);
  return { inputs, result: buildWorkloadProfile(inputs, rules) };
};

describe('resolveProfileInputs - nothing asked twice, nothing silently assumed', () => {
  it('prefers the profile answer, then Discovery, then the project, and records the source', () => {
    const { inputs } = profile({ peakQps: 999 });
    expect(inputs.peakQps).toEqual({ value: 999, source: 'profile' });
    expect(inputs.expectedVectorCount).toEqual({ value: 5_000_000, source: 'discovery', detail: 'Discovery v4' });
    expect(inputs.businessDomain).toEqual({ value: 'Healthcare', source: 'project', detail: 'project details' });
    expect(inputs.containsPhi).toEqual({ value: null, source: 'missing' });
  });

  it('derives daily requests from Discovery QPS and says so', () => {
    expect(profile().inputs.dailyRequests).toEqual({ value: 432_000, source: 'derived', detail: 'Discovery v4 qps 5 × 86,400' });
    expect(profile({ dailyRequests: 1000 }).inputs.dailyRequests).toEqual({ value: 1000, source: 'profile' });
  });

  it('only infers a deployment target from Discovery when it names one (on-premises)', () => {
    const blankTargets = { ...base, deploymentTargets: [] as DeploymentTarget[] };
    expect(resolveProfileInputs(blankTargets, discovery, project).deploymentTargets.source).toBe('missing');
    expect(resolveProfileInputs(blankTargets, { ...discovery, deploymentEnvironment: 'on_premises' }, project).deploymentTargets).toEqual({ value: ['on_premises'], source: 'discovery', detail: 'Discovery v4' });
  });

  it('works without any Discovery assessment', () => {
    const { inputs, result } = profile({}, null);
    expect(inputs.expectedVectorCount.source).toBe('missing');
    expect(result.status).toBe('incomplete');
    expect(result.missingInputs).toEqual(['dailyRequests', 'expectedVectorCount']);
  });
});

describe('buildWorkloadProfile', () => {
  it('is complete when every required answer is present', () => {
    const { result } = profile();
    expect(result.status).toBe('complete');
    expect(result.missingInputs).toEqual([]);
  });

  describe('workload size (highest tier across answered dimensions)', () => {
    it('classifies against ascending bounds', () => {
      const tiers = rules.sizeTiers;
      expect(classifySize(0, [10, 100], tiers)).toBe('small');
      expect(classifySize(10, [10, 100], tiers)).toBe('medium');
      expect(classifySize(5e9, rules.sizeDimensions.expectedVectorCount.bounds, tiers)).toBe('extreme_scale');
    });

    it('never averages away one extreme dimension', () => {
      const { result } = profile({ expectedVectorCount: 2_000_000_000, dailyRequests: 500, expectedUsers: 20 });
      expect(result.workloadSize.tier).toBe('extreme_scale');
      expect(result.workloadSize.drivers.find((d) => d.dimension === 'dailyRequests')?.tier).toBe('small');
      expect(result.workloadSize.explanation).toMatch(/^Extreme Scale - driven by vector count \(2,000,000,000\)/);
    });

    it('reports the drivers of a medium workload from Discovery values', () => {
      const { result } = profile();
      // 5M vectors → medium; 432k/day → large; peak 20 → medium; 300 concurrent → medium
      expect(result.workloadSize.tier).toBe('large');
      expect(result.workloadSize.explanation).toContain('daily requests (432,000)');
    });
  });

  describe('architecture class', () => {
    it.each([
      [[AiWorkloadType.RAG], [DataType.DOCUMENTS], 'rag'],
      [[AiWorkloadType.QUESTION_ANSWERING, AiWorkloadType.RAG], [], 'rag'],
      [[AiWorkloadType.AGENTIC], [], 'agent'],
      [[AiWorkloadType.COPILOT], [], 'copilot'],
      [[AiWorkloadType.SUMMARIZATION, AiWorkloadType.CLASSIFICATION], [], 'generative_ai'],
      [[AiWorkloadType.SEARCH], [DataType.STRUCTURED], 'search'],
      [[AiWorkloadType.RAG, AiWorkloadType.AGENTIC], [], 'hybrid'],
      [[AiWorkloadType.RAG], [DataType.IMAGES], 'hybrid'],
      [[AiWorkloadType.MULTIMODAL], [DataType.VIDEO], 'multimodal'],
      [[AiWorkloadType.OTHER], [], null],
    ])('%p with data %p → %p', (types, dataTypes, expected) => {
      expect(profile({ workloadTypes: types as AiWorkloadType[], dataTypes: dataTypes as DataType[] }).result.architecture.class).toBe(expected);
    });

    it('explains why a text workload became multimodal', () => {
      const { result } = profile({ dataTypes: [DataType.DOCUMENTS, DataType.AUDIO] });
      expect(result.architecture.components).toEqual(['rag', 'multimodal']);
      expect(result.architecture.explanation).toBe('Hybrid - combines RAG + Multimodal (multimodal because the data includes audio).');
    });
  });

  describe('data classification and required controls', () => {
    it('restricted beats confidential beats internal', () => {
      expect(profile({ containsPhi: true }).result.dataClassification).toMatchObject({ level: 'restricted', reasons: ['Contains PHI (health data).'] });
      expect(profile({ containsPci: true, containsPii: true }).result.dataClassification.level).toBe('restricted');
      expect(profile().result.dataClassification).toMatchObject({ level: 'confidential', reasons: ['Contains PII (personal data).'] });
      expect(profile({ containsPii: false }).result.dataClassification.level).toBe('internal');
    });

    it('lists the controls for the level and what Discovery already requires', () => {
      const r = profile({ containsPhi: true }).result;
      expect(r.securityRequirements.controls).toEqual(rules.requiredControls.restricted);
      expect(r.securityRequirements.alreadyRequired).toEqual(['Encryption at rest', 'Encryption in transit']);
      expect(r.securityRequirements.notes[0]).toMatch(/GDPR/);
    });

    it('flags a sensitive workload whose Discovery did not require encryption at rest', () => {
      const r = profile({ containsPhi: true }, { ...discovery, requiresEncryptionAtRest: false }).result;
      expect(r.securityRequirements.notes).toContainEqual(expect.stringMatching(/restricted but encryption at rest was not marked/));
    });
  });

  describe('deployment requirements (technology-neutral)', () => {
    it('marks more than one target as hybrid', () => {
      const r = profile({ deploymentTargets: [DeploymentTarget.ON_PREMISES, DeploymentTarget.OCI] }).result;
      expect(r.deploymentRequirements.hybrid).toBe(true);
      expect(r.deploymentRequirements.notes[0]).toMatch(/Hybrid across On-premises \+ OCI/);
    });

    it('warns that on-premises-only rules out managed services, and flags missing GPUs', () => {
      const r = profile({ deploymentTargets: [DeploymentTarget.ON_PREMISES] }).result;
      expect(r.deploymentRequirements.notes).toEqual(
        expect.arrayContaining([expect.stringMatching(/On-premises only/), expect.stringMatching(/Data residency "EU"/), expect.stringMatching(/No GPU capacity/)]),
      );
    });

    it('does not mention GPUs for search-only workloads', () => {
      const r = profile({ workloadTypes: [AiWorkloadType.SEARCH] }).result;
      expect(r.deploymentRequirements.notes.some((n) => n.includes('GPU'))).toBe(false);
    });
  });

  describe('explainability', () => {
    it('labels customer answers as assumptions and derived values as estimates', () => {
      const r = profile().result;
      expect(r.scaleProfile.find((x) => x.label === 'Daily requests')).toEqual({ label: 'Daily requests', value: '432,000 (Discovery v4 qps 5 × 86,400)', evidenceType: 'estimated' });
      expect(r.scaleProfile.find((x) => x.label === 'Vectors')?.evidenceType).toBe('assumption');
      expect(r.scaleProfile.find((x) => x.label === 'Monthly requests')?.value).toBe('13,132,800 (daily × 30.4)');
      expect(r.assumptions).toContainEqual({ statement: 'expectedVectorCount = 5000000 - taken from Discovery v4', evidenceType: 'assumption' });
      expect(r.assumptions.every((a) => !a.statement.startsWith('businessObjective'))).toBe(true); // typed into the profile, not assumed
    });
  });
});

describe('ResolvedProfileInputs shape', () => {
  it('covers every DTO field (so a new question cannot be silently ignored)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'create-workload-profile.dto.ts'), 'utf8');
    // Property declarations only ("name?: Type;"), not keys inside decorator options.
    const dtoFields = [...src.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*)[?!]?:\s*[A-Za-z][A-Za-z0-9_[\]]*;/g)].map((m) => m[1]);
    const resolved = Object.keys(resolveProfileInputs(base, discovery, project) as ResolvedProfileInputs);
    expect(dtoFields.length).toBeGreaterThan(20);
    expect(dtoFields.filter((f) => !resolved.includes(f))).toEqual([]);
  });
});
