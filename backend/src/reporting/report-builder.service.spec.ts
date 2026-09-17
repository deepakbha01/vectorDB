import { ReportBuilderService } from './report-builder.service';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { IndexType } from '../index-recommendation-engine/enums/index-type.enum';
import { ChunkingStrategy } from '../chunking/enums/chunking-strategy.enum';
import { Environment } from '../discovery/enums/discovery.enum';

describe('ReportBuilderService', () => {
  let service: ReportBuilderService;

  beforeEach(() => {
    service = new ReportBuilderService();
  });

  it('builds a Discovery/ADR report with decision, requirements, and risks sections', () => {
    const assessment: any = {
      version: 2,
      environment: Environment.PRODUCTION,
      estimatedVectorCount: 500_000,
      embeddingDimension: 768,
      qps: 20,
      peakQps: 60,
      targetP95LatencyMs: 150,
      targetP99LatencyMs: 300,
      recallTarget: 0.9,
      requiresReranking: false,
      operationalCapability: 'part_time',
      requiresMultiRegion: false,
      tenancyModel: 'single_tenant',
      availabilityTargetPercent: 99.5,
      rpoMinutes: 60,
      rtoMinutes: 120,
    };
    const adr: any = {
      rulesVersion: '1.0.0',
      decision: VectorPlatform.POSTGRES_PGVECTOR,
      rationale: 'Because reasons.',
      operationalComplexity: 'low',
      options: [
        {
          platformId: VectorPlatform.POSTGRES_PGVECTOR,
          label: 'PostgreSQL + pgvector',
          totalScore: 0.9,
          criteriaScores: {
            vectorCount: 1,
            qps: 1,
            latency: 1,
            recall: 0.85,
            existingPlatform: 1,
            operationalComplexity: 1,
            cost: 0.95,
          },
          evidence: ['Estimated vector count scored 1.00 against thresholds.'],
          eligible: true,
          ineligibleReasons: [],
        },
      ],
      rejectedAlternatives: [{ platformId: VectorPlatform.MILVUS, reason: 'overkill' }],
      assumptions: ['assumption 1'],
      risks: ['risk 1'],
      infrastructureEstimate: { estimatedMemoryGb: 2, estimatedStorageGb: 4, estimatedCpuCores: 2 },
    };

    const doc = service.buildDiscoveryReport(assessment, adr);

    expect(doc.title).toBe('Architecture Decision Record');
    expect(doc.subtitle).toContain('version 2');
    expect(doc.sections.map((s) => s.heading)).toContain('Decision');
    expect(doc.sections.find((s) => s.heading === 'Risks')?.lists?.[0].items).toEqual(['risk 1']);
  });

  it('builds a Data Pipeline Design report including the pipeline stage table', () => {
    const design: any = {
      version: 1,
      collectionName: 'docs',
      chunkingStrategy: ChunkingStrategy.RECURSIVE,
      chunkSize: 500,
      chunkOverlap: 50,
      embeddingProviderId: 'openai',
      embeddingModelId: 'text-embedding-3-small',
      embeddingDimension: 1536,
      maxInputTokens: 8191,
      costPerMillionTokens: 0.02,
      qualityTier: 'high',
      pipelineStages: [{ name: 'Chunk', description: 'Splits text.' }],
      errorHandling: { retryCount: 3, retryBackoffMs: 2000, deadLetterEnabled: true, batchSize: 100 },
      validationWarnings: [],
      generatedSchemas: { postgres_pgvector: { ddl: 'CREATE TABLE docs (...);' }, oracle: { ddl: 'CREATE TABLE docs (...);' } },
    };

    const doc = service.buildDataPipelineReport(design);

    expect(doc.title).toBe('Data Pipeline Design');
    const pipelineSection = doc.sections.find((s) => s.heading.startsWith('Pipeline:'));
    expect(pipelineSection?.tables?.[0].rows).toEqual([['Chunk', 'Splits text.']]);
  });

  it('builds an Index Design report with requirements, scored options, and the configuration table', () => {
    const design: any = {
      version: 1,
      rulesVersion: '1.0.0',
      label: 'HNSW',
      rationale: 'HNSW wins.',
      configuration: [{ name: 'M', value: 16, description: 'connectivity' }],
      impact: { recallEstimate: 'ok', latencyEstimate: 'ok', memoryEstimateGb: 2 },
      scalingConsiderations: ['consider sharding'],
      alternatives: [{ indexType: IndexType.IVF_FLAT, reason: 'weaker recall' }],
      inputsUsed: {
        vectorCount: 500_000,
        dimension: 768,
        availableMemoryGb: 16,
        qps: 20,
        recallTarget: 0.9,
        targetP95LatencyMs: 150,
        topK: 10,
        updateFrequency: 'moderate',
      },
      options: [
        {
          indexType: IndexType.HNSW,
          label: 'HNSW',
          totalScore: 0.9,
          criteriaScores: { recall: 0.95, latency: 0.9, memory: 0.7, throughput: 0.85, updateFriendliness: 0.8 },
          estimatedMemoryGb: 2,
          evidence: ['Recall target scored 0.95 against thresholds.'],
        },
      ],
      criteriaWeights: { recall: 0.25, latency: 0.2, memory: 0.2, throughput: 0.2, updateFriendliness: 0.15 },
    };

    const doc = service.buildIndexDesignReport(design);

    expect(doc.title).toBe('Indexing Strategy Guide');
    expect(doc.sections.find((s) => s.heading === 'Requirements considered')?.fields).toContainEqual({
      label: 'Estimated vector count',
      value: '500,000',
    });
    const howCalculated = doc.sections.find((s) => s.heading === 'Scored options')?.fields?.[0].value;
    expect(howCalculated).toContain('recall (25%)');
    expect(howCalculated).toContain('latency (20%)');
    expect(howCalculated).toContain('update-friendliness (15%)');
    expect(doc.sections.find((s) => s.heading === 'Scored options')?.tables?.[0].rows).toEqual([
      ['HNSW', '0.90', '0.95', '0.90', '0.70', '0.85', '0.80', '2GB'],
    ]);
    expect(doc.sections.find((s) => s.heading === 'Scored options')?.lists?.[0]).toEqual({
      title: 'Why HNSW scored this way',
      items: ['Recall target scored 0.95 against thresholds.'],
    });
    expect(doc.sections.find((s) => s.heading === 'Configuration')?.tables?.[0].rows).toEqual([['M', '16', 'connectivity']]);
  });

  it('builds a Deployment Plan report and includes Kubernetes artifacts only when present', () => {
    const plan: any = {
      version: 1,
      platform: VectorPlatform.MILVUS,
      collectionName: 'docs',
      executed: false,
      sqlScript: '// milvus schema json',
      terraform: '# terraform',
      healthCheck: { description: 'ping', check: 'checkHealth()' },
      deploymentChecklist: ['step 1'],
      rollbackProcedure: ['rollback step'],
      kubernetesArtifacts: { namespaceYaml: 'kind: Namespace', helmValuesYaml: 'cluster: enabled' },
    };

    const doc = service.buildDeploymentPlanReport(plan);

    expect(doc.sections.some((s) => s.heading === 'Kubernetes / Helm')).toBe(true);

    const withoutK8s = service.buildDeploymentPlanReport({ ...plan, kubernetesArtifacts: undefined });
    expect(withoutK8s.sections.some((s) => s.heading === 'Kubernetes / Helm')).toBe(false);
  });

  it('builds an Optimization Report with the comparison table', () => {
    const report: any = {
      version: 1,
      indexType: IndexType.HNSW,
      recommendedVariant: { searchParamName: 'efSearch', searchParamValue: 100, p95LatencyMs: 20, avgRecall: 0.95, achievedQps: 50 },
      variantResults: [
        { searchParamName: 'efSearch', searchParamValue: 100, isBaseline: true, p50LatencyMs: 10, p95LatencyMs: 20, p99LatencyMs: 25, avgRecall: 0.95, achievedQps: 50 },
      ],
      bottlenecks: ['none'],
      beforeAfterComparison: {
        baseline: { searchParamValue: 100, p95LatencyMs: 20, avgRecall: 0.95 },
        recommended: { searchParamValue: 100, p95LatencyMs: 20, avgRecall: 0.95 },
      },
      capacityImpact: { estimatedMemoryGb: 2 },
      costImplications: { estimatedCostPerHourUsd: 0.1 },
    };

    const doc = service.buildOptimizationReport(report);

    expect(doc.title).toBe('Optimization Report');
    expect(doc.sections.find((s) => s.heading.includes('Latency vs Recall'))?.tables?.[0].headers).toContain('efSearch');
  });

  it('builds a Capacity Plan report with the timeline table', () => {
    const plan: any = {
      version: 1,
      platform: VectorPlatform.POSTGRES_PGVECTOR,
      currentState: { vectorCount: 1_000_000, qps: 50, memoryGb: 5, storageGb: 10, cpuCores: 4 },
      forecast: [{ horizonMonths: 6, projectedVectorCount: 1_300_000, projectedQps: 65, estimatedMemoryGb: 6.5, estimatedStorageGb: 13, estimatedCpuCores: 4.5, scalingTriggersHit: [] }],
      shardingRecommendation: { strategy: 'vertical', details: ['scale up'] },
      haRecommendation: ['multi-az'],
      drRecommendation: ['backup often'],
      recommendedInfrastructure: ['provision more RAM'],
    };

    const doc = service.buildCapacityPlanReport(plan);

    expect(doc.title).toBe('Capacity Plan');
    expect(doc.sections.find((s) => s.heading === 'Capacity timeline')?.tables?.[0].rows[0][0]).toBe('6mo');
  });

  it('builds a Complete Assessment Report showing incomplete phases honestly', () => {
    const project: any = { name: 'RAG Assistant', platform: VectorPlatform.POSTGRES_PGVECTOR, platformIsManualOverride: false };
    const doc = service.buildCompleteReport(project, {});

    expect(doc.title).toBe('Complete Assessment Report');
    const completionTable = doc.sections.find((s) => s.heading === 'Phase completion')?.tables?.[0];
    expect(completionTable?.rows.every((r) => r[1].includes('Not started'))).toBe(true);
  });

  it('includes a completed phase\'s full sub-sections in the Complete Assessment Report', () => {
    const project: any = { name: 'RAG Assistant', platform: VectorPlatform.MILVUS, platformIsManualOverride: true };
    const indexDesign: any = {
      version: 1,
      rulesVersion: '1.0.0',
      label: 'HNSW',
      rationale: 'HNSW wins.',
      configuration: [],
      impact: { recallEstimate: 'ok', latencyEstimate: 'ok', memoryEstimateGb: 2 },
      scalingConsiderations: [],
      alternatives: [],
      inputsUsed: {
        vectorCount: 100_000,
        dimension: 768,
        availableMemoryGb: 16,
        qps: 10,
        recallTarget: 0.9,
        targetP95LatencyMs: 150,
        topK: 10,
        updateFrequency: 'moderate',
      },
      options: [],
      criteriaWeights: { recall: 0.25, latency: 0.2, memory: 0.2, throughput: 0.2, updateFriendliness: 0.15 },
    };

    const doc = service.buildCompleteReport(project, { indexDesign });

    expect(doc.sections.some((s) => s.heading.includes('Indexing Strategy Guide'))).toBe(true);
    expect(doc.sections.some((s) => s.heading === 'Configuration')).toBe(true);
  });
});
