import { Injectable } from '@nestjs/common';
import { Project } from '../projects/project.entity';
import { DiscoveryAssessment } from '../discovery/discovery-assessment.entity';
import { ArchitectureDecisionRecord } from '../discovery/architecture-decision-record.entity';
import { DataPipelineDesign } from '../data-pipeline/data-pipeline-design.entity';
import { IndexDesign } from '../index-design/index-design.entity';
import { DeploymentPlan } from '../deployment/deployment-plan.entity';
import { OptimizationReport } from '../benchmark/optimization-report.entity';
import { CapacityPlan } from '../capacity-planning/capacity-plan.entity';
import { FitRating } from '../recommendation-engine/recommendation.types';
import { ReportDocument, ReportSection } from './report-document.types';

const RATING_LABEL: Record<FitRating, string> = {
  great: 'Strong',
  ok: 'Adequate',
  weak: 'Limited',
};

function formatWeightPercent(weight: number): string {
  return `${Math.round(weight * 100)}%`;
}

@Injectable()
export class ReportBuilderService {
  buildDiscoveryReport(assessment: DiscoveryAssessment, adr: ArchitectureDecisionRecord): ReportDocument {
    const summary = adr.plainLanguageSummary;
    const sections: ReportSection[] = [];

    if (summary) {
      // `fields` (not `paragraphs`) so this prose renders in the normal body
      // font - both renderers force `paragraphs` into a monospace font meant
      // for code/DDL blocks elsewhere in this report.
      sections.push({
        heading: 'Executive Summary',
        fields: [
          { label: 'Summary', value: summary.headline },
          { label: 'Cost & Operational Effort', value: summary.costAndEffort },
          { label: 'Recommendation', value: summary.bottomLine },
        ],
        tables: [
          {
            title: 'Evaluation Summary',
            headers: ['Factor', 'Rating', 'Assessment'],
            rows: summary.scorecard.map((row) => [row.label, RATING_LABEL[row.rating], row.explanation]),
          },
        ],
        lists: [{ title: 'Key Considerations', items: summary.risks }],
      });
    }

    sections.push(
        {
          heading: 'Decision',
          fields: [
            { label: 'Recommended platform', value: adr.decision },
            { label: 'Operational complexity', value: adr.operationalComplexity },
          ],
          paragraphs: [adr.rationale],
        },
        {
          heading: 'Requirements considered',
          fields: [
            { label: 'Environment', value: assessment.environment },
            { label: 'Estimated vector count', value: assessment.estimatedVectorCount.toLocaleString() },
            { label: 'Embedding dimension', value: String(assessment.embeddingDimension) },
            { label: 'QPS (sustained / peak)', value: `${assessment.qps} / ${assessment.peakQps}` },
            { label: 'Target P95 / P99 latency', value: `${assessment.targetP95LatencyMs}ms / ${assessment.targetP99LatencyMs}ms` },
            { label: 'Recall target', value: String(assessment.recallTarget) },
            ...(assessment.precisionTarget !== undefined && assessment.precisionTarget !== null
              ? [{ label: 'Precision target', value: String(assessment.precisionTarget) }]
              : []),
            { label: 'Reranking required', value: String(assessment.requiresReranking) },
            { label: 'Operational capability', value: assessment.operationalCapability },
            ...(assessment.monthlyBudgetUsd !== undefined && assessment.monthlyBudgetUsd !== null
              ? [{ label: 'Monthly budget', value: `$${assessment.monthlyBudgetUsd}` }]
              : []),
            { label: 'Multi-region required', value: String(assessment.requiresMultiRegion) },
            { label: 'Tenancy model', value: assessment.tenancyModel },
            { label: 'Availability target', value: `${assessment.availabilityTargetPercent}%` },
            { label: 'RPO / RTO', value: `${assessment.rpoMinutes}min / ${assessment.rtoMinutes}min` },
          ],
        },
        {
          heading: 'Scored options',
          fields: [
            {
              label: 'How this is calculated',
              value:
                'Each candidate is scored 0-1 on seven weighted criteria - vector-volume fit, query throughput, latency fit, recall fit, ' +
                'existing-platform fit, operational complexity, and cost - using the thresholds and weights in rules v' +
                adr.rulesVersion +
                '. Each criterion score is multiplied by its weight and the results are summed into the total score below. A candidate ' +
                'that fails a required search capability (hybrid search, full-text search, or metadata filtering) is marked ineligible ' +
                'and cannot win regardless of score; among eligible candidates, the winner is whichever totals highest.',
            },
          ],
          tables: [
            {
              title: 'Total and per-criterion scores (0-1, higher is better)',
              headers: ['Platform', 'Eligible', 'Total', 'Vector Count', 'QPS', 'Latency', 'Recall', 'Existing', 'Ops', 'Cost'],
              rows: adr.options.map((o) => [
                o.label,
                o.eligible ? 'Yes' : 'No',
                o.totalScore.toFixed(2),
                o.criteriaScores.vectorCount.toFixed(2),
                o.criteriaScores.qps.toFixed(2),
                o.criteriaScores.latency.toFixed(2),
                o.criteriaScores.recall.toFixed(2),
                o.criteriaScores.existingPlatform.toFixed(2),
                o.criteriaScores.operationalComplexity.toFixed(2),
                o.criteriaScores.cost.toFixed(2),
              ]),
            },
          ],
          lists: adr.options.map((o) => ({ title: `Why ${o.label} scored this way`, items: o.evidence })),
        },
        {
          heading: 'Rejected alternatives',
          lists: [{ items: adr.rejectedAlternatives.map((r) => `${r.platformId}: ${r.reason}`) }],
        },
        {
          heading: 'Infrastructure estimate',
          fields: [
            { label: 'Raw vector data size', value: `${adr.infrastructureEstimate.estimatedRawVectorGb}GB` },
            { label: 'Estimated memory', value: `${adr.infrastructureEstimate.estimatedMemoryGb}GB` },
            { label: 'Estimated storage', value: `${adr.infrastructureEstimate.estimatedStorageGb}GB` },
            { label: 'Estimated CPU cores', value: String(adr.infrastructureEstimate.estimatedCpuCores) },
          ],
          lists: [{ title: 'How these figures are calculated', items: adr.infrastructureEstimate.notes }],
        },
        { heading: 'Assumptions', lists: [{ items: adr.assumptions }] },
        { heading: 'Risks', lists: [{ items: adr.risks }] },
    );

    return {
      title: 'Architecture Decision Record',
      subtitle: `Assessment version ${assessment.version} - rules v${adr.rulesVersion}`,
      generatedAt: new Date().toISOString(),
      sections,
    };
  }

  buildDataPipelineReport(design: DataPipelineDesign): ReportDocument {
    const summary = design.executiveSummary;
    const sections: ReportSection[] = [];

    if (summary) {
      sections.push({
        heading: 'Executive Summary',
        fields: [
          { label: 'Summary', value: summary.headline },
          { label: 'Cost & Effort', value: summary.costAndEffort },
          { label: 'Recommendation', value: summary.bottomLine },
        ],
        tables: [
          {
            title: 'Evaluation Summary',
            headers: ['Factor', 'Rating', 'Assessment'],
            rows: summary.scorecard.map((row) => [row.label, RATING_LABEL[row.rating], row.explanation]),
          },
        ],
        lists: [{ title: 'Key Considerations', items: summary.considerations }],
      });
    }

    sections.push(
        {
          heading: 'Chunking',
          fields: [
            { label: 'Strategy', value: design.chunkingStrategy },
            { label: 'Chunk size', value: String(design.chunkSize) },
            { label: 'Chunk overlap', value: String(design.chunkOverlap) },
          ],
        },
        {
          heading: 'Embedding model',
          fields: [
            { label: 'Provider', value: design.embeddingProviderId },
            { label: 'Model', value: design.embeddingModelId },
            { label: 'Dimension', value: String(design.embeddingDimension) },
            { label: 'Max input tokens', value: String(design.maxInputTokens) },
            { label: 'Cost per million tokens', value: `$${design.costPerMillionTokens}` },
            { label: 'Quality tier', value: design.qualityTier },
          ],
        },
        {
          heading: 'Pipeline: Source -> Extract -> Clean -> Chunk -> Embed -> Validate -> Store -> Index',
          tables: [
            {
              headers: ['Stage', 'Description'],
              rows: design.pipelineStages.map((s) => [s.name, s.description]),
            },
          ],
          fields: [
            { label: 'Retry count', value: String(design.errorHandling.retryCount) },
            { label: 'Retry backoff', value: `${design.errorHandling.retryBackoffMs}ms` },
            { label: 'Dead-letter enabled', value: String(design.errorHandling.deadLetterEnabled) },
            { label: 'Batch size', value: String(design.errorHandling.batchSize) },
          ],
        },
        design.validationWarnings.length > 0
          ? { heading: 'Validation warnings', lists: [{ items: design.validationWarnings }] }
          : { heading: 'Validation warnings', paragraphs: ['None.'] },
        {
          heading: 'Generated schema (PostgreSQL + pgvector)',
          paragraphs: [design.generatedSchemas.postgres_pgvector.ddl],
        },
        {
          heading: 'Generated schema (Oracle)',
          paragraphs: [design.generatedSchemas.oracle.ddl],
        },
    );

    return {
      title: 'Data Pipeline Design',
      subtitle: `Version ${design.version} - collection '${design.collectionName}'`,
      generatedAt: new Date().toISOString(),
      sections,
    };
  }

  buildIndexDesignReport(design: IndexDesign): ReportDocument {
    return {
      title: 'Indexing Strategy Guide',
      subtitle: `Version ${design.version} - rules v${design.rulesVersion}`,
      generatedAt: new Date().toISOString(),
      sections: [
        {
          heading: 'Recommendation',
          fields: [{ label: 'Index type', value: design.label }],
          paragraphs: [design.rationale],
        },
        {
          heading: 'Requirements considered',
          fields: [
            { label: 'Estimated vector count', value: design.inputsUsed.vectorCount.toLocaleString() },
            { label: 'Embedding dimension', value: String(design.inputsUsed.dimension) },
            { label: 'Available memory', value: `${design.inputsUsed.availableMemoryGb}GB` },
            { label: 'QPS', value: String(design.inputsUsed.qps) },
            { label: 'Recall target', value: String(design.inputsUsed.recallTarget) },
            { label: 'Target P95 latency', value: `${design.inputsUsed.targetP95LatencyMs}ms` },
            { label: 'Top K', value: String(design.inputsUsed.topK) },
            { label: 'Update frequency', value: design.inputsUsed.updateFrequency },
          ],
        },
        {
          heading: 'Scored options',
          fields: [
            {
              label: 'How this is calculated',
              value: design.criteriaWeights
                ? `Each candidate index type is scored 0-1 on five criteria, each weighted per rules v${design.rulesVersion}: ` +
                  `recall (${formatWeightPercent(design.criteriaWeights.recall)}), ` +
                  `latency (${formatWeightPercent(design.criteriaWeights.latency)}), ` +
                  `memory footprint (${formatWeightPercent(design.criteriaWeights.memory)}), ` +
                  `throughput (${formatWeightPercent(design.criteriaWeights.throughput)}), and ` +
                  `update-friendliness (${formatWeightPercent(design.criteriaWeights.updateFriendliness)}). ` +
                  'Total score = (recall score x recall weight) + (latency score x latency weight) + (memory score x memory weight) + ' +
                  '(throughput score x throughput weight) + (update-friendliness score x update-friendliness weight); the winner is whichever candidate totals highest.'
                : 'Each candidate index type is scored 0-1 on five weighted criteria - recall, latency, memory footprint, throughput, ' +
                  `and update-friendliness - using the thresholds and weights in rules v${design.rulesVersion}. Weight values are not ` +
                  'available for this design version - re-run "Revise Design" to record them. Each criterion score is multiplied by ' +
                  'its weight and the results are summed into the total score below; the winner is whichever candidate totals highest.',
            },
          ],
          tables: [
            {
              title: 'Total and per-criterion scores (0-1, higher is better)',
              headers: ['Index type', 'Total', 'Recall', 'Latency', 'Memory', 'Throughput', 'Update-friendliness', 'Est. memory'],
              rows: design.options.map((o) => [
                o.label,
                o.totalScore.toFixed(2),
                o.criteriaScores.recall.toFixed(2),
                o.criteriaScores.latency.toFixed(2),
                o.criteriaScores.memory.toFixed(2),
                o.criteriaScores.throughput.toFixed(2),
                o.criteriaScores.updateFriendliness.toFixed(2),
                `${o.estimatedMemoryGb}GB`,
              ]),
            },
          ],
          lists: design.options.map((o) => ({ title: `Why ${o.label} scored this way`, items: o.evidence })),
        },
        {
          heading: 'Configuration',
          tables: [
            {
              headers: ['Parameter', 'Value', 'Description'],
              rows: design.configuration.map((c) => [c.name, String(c.value), c.description]),
            },
          ],
        },
        {
          heading: 'Impact',
          fields: [
            { label: 'Recall estimate', value: design.impact.recallEstimate },
            { label: 'Latency estimate', value: design.impact.latencyEstimate },
            { label: 'Memory estimate', value: `${design.impact.memoryEstimateGb}GB` },
          ],
        },
        { heading: 'Scaling considerations', lists: [{ items: design.scalingConsiderations }] },
        {
          heading: 'Alternatives',
          lists: [{ items: design.alternatives.map((a) => `${a.indexType}: ${a.reason}`) }],
        },
      ],
    };
  }

  buildDeploymentPlanReport(plan: DeploymentPlan): ReportDocument {
    const sections: ReportSection[] = [
      {
        heading: 'Deployment overview',
        fields: [
          { label: 'Version', value: String(plan.version) },
          { label: 'Platform', value: plan.platform },
          { label: 'Collection / table', value: plan.collectionName },
          { label: 'Executed', value: plan.executed ? `Yes, at ${plan.executedAt}` : 'Not yet executed' },
        ],
      },
      { heading: 'SQL / schema script', paragraphs: [plan.sqlScript] },
      { heading: 'Terraform', paragraphs: [plan.terraform] },
      {
        heading: 'Health check',
        fields: [
          { label: 'Description', value: plan.healthCheck.description },
          { label: 'Check', value: plan.healthCheck.check },
        ],
      },
      { heading: 'Deployment checklist', lists: [{ items: plan.deploymentChecklist }] },
      { heading: 'Rollback procedure', lists: [{ items: plan.rollbackProcedure }] },
    ];
    if (plan.kubernetesArtifacts) {
      sections.push({
        heading: 'Kubernetes / Helm',
        paragraphs: [plan.kubernetesArtifacts.namespaceYaml, plan.kubernetesArtifacts.helmValuesYaml],
      });
    }
    return {
      title: 'Deployment Plan',
      subtitle: `Version ${plan.version}`,
      generatedAt: new Date().toISOString(),
      sections,
    };
  }

  buildOptimizationReport(report: OptimizationReport): ReportDocument {
    return {
      title: 'Optimization Report',
      subtitle: `Version ${report.version} - ${report.indexType}`,
      generatedAt: new Date().toISOString(),
      sections: [
        {
          heading: 'Recommended configuration',
          fields: [
            { label: report.recommendedVariant.searchParamName, value: String(report.recommendedVariant.searchParamValue) },
            { label: 'P95 latency', value: `${report.recommendedVariant.p95LatencyMs}ms` },
            { label: 'Recall', value: String(report.recommendedVariant.avgRecall) },
            { label: 'Achieved QPS', value: String(report.recommendedVariant.achievedQps) },
          ],
        },
        {
          heading: 'Latency vs Recall vs Memory vs Cost',
          tables: [
            {
              headers: [report.variantResults[0]?.searchParamName ?? 'Parameter', 'P50', 'P95', 'P99', 'Recall', 'QPS'],
              rows: report.variantResults.map((v) => [
                String(v.searchParamValue) + (v.isBaseline ? ' (baseline)' : ''),
                `${v.p50LatencyMs}ms`,
                `${v.p95LatencyMs}ms`,
                `${v.p99LatencyMs}ms`,
                String(v.avgRecall),
                String(v.achievedQps),
              ]),
            },
          ],
          fields: [
            { label: 'Estimated memory', value: `${report.capacityImpact.estimatedMemoryGb}GB` },
            { label: 'Estimated cost', value: `$${report.costImplications.estimatedCostPerHourUsd}/hour` },
          ],
        },
        { heading: 'Bottlenecks', lists: [{ items: report.bottlenecks }] },
        {
          heading: 'Before / after',
          fields: [
            { label: 'Baseline', value: `${report.beforeAfterComparison.baseline.searchParamValue} (P95 ${report.beforeAfterComparison.baseline.p95LatencyMs}ms, recall ${report.beforeAfterComparison.baseline.avgRecall})` },
            { label: 'Recommended', value: `${report.beforeAfterComparison.recommended.searchParamValue} (P95 ${report.beforeAfterComparison.recommended.p95LatencyMs}ms, recall ${report.beforeAfterComparison.recommended.avgRecall})` },
          ],
        },
      ],
    };
  }

  buildCapacityPlanReport(plan: CapacityPlan): ReportDocument {
    return {
      title: 'Capacity Plan',
      subtitle: `Version ${plan.version} - ${plan.platform}`,
      generatedAt: new Date().toISOString(),
      sections: [
        {
          heading: 'Current state',
          fields: [
            { label: 'Vector count', value: plan.currentState.vectorCount.toLocaleString() },
            { label: 'QPS', value: String(plan.currentState.qps) },
            { label: 'Memory', value: `${plan.currentState.memoryGb.toFixed(1)}GB` },
            { label: 'Storage', value: `${plan.currentState.storageGb.toFixed(1)}GB` },
            { label: 'CPU cores', value: plan.currentState.cpuCores.toFixed(1) },
          ],
        },
        {
          heading: 'Capacity timeline',
          tables: [
            {
              headers: ['Horizon', 'Vectors', 'QPS', 'Memory', 'Storage', 'CPU', 'Triggers'],
              rows: plan.forecast.map((f) => [
                `${f.horizonMonths}mo`,
                f.projectedVectorCount.toLocaleString(),
                String(f.projectedQps),
                `${f.estimatedMemoryGb.toFixed(1)}GB`,
                `${f.estimatedStorageGb.toFixed(1)}GB`,
                f.estimatedCpuCores.toFixed(1),
                String(f.scalingTriggersHit.length),
              ]),
            },
          ],
        },
        {
          heading: `Sharding: ${plan.shardingRecommendation.strategy}`,
          lists: [{ items: plan.shardingRecommendation.details }],
        },
        { heading: 'High availability', lists: [{ items: plan.haRecommendation }] },
        { heading: 'Disaster recovery', lists: [{ items: plan.drRecommendation }] },
        { heading: 'Recommended infrastructure', lists: [{ items: plan.recommendedInfrastructure }] },
      ],
    };
  }

  buildCompleteReport(
    project: Project,
    parts: {
      discovery?: { assessment: DiscoveryAssessment; adr: ArchitectureDecisionRecord };
      dataPipeline?: DataPipelineDesign;
      indexDesign?: IndexDesign;
      deploymentPlan?: DeploymentPlan;
      optimizationReport?: OptimizationReport;
      capacityPlan?: CapacityPlan;
    },
  ): ReportDocument {
    const phases: Array<{ name: string; done: boolean; sub?: ReportDocument }> = [
      { name: '1. Discovery', done: !!parts.discovery, sub: parts.discovery && this.buildDiscoveryReport(parts.discovery.assessment, parts.discovery.adr) },
      { name: '2. Data & Embeddings', done: !!parts.dataPipeline, sub: parts.dataPipeline && this.buildDataPipelineReport(parts.dataPipeline) },
      { name: '3. Index Design', done: !!parts.indexDesign, sub: parts.indexDesign && this.buildIndexDesignReport(parts.indexDesign) },
      { name: '4. Infrastructure', done: !!parts.deploymentPlan, sub: parts.deploymentPlan && this.buildDeploymentPlanReport(parts.deploymentPlan) },
      { name: '6. Optimization', done: !!parts.optimizationReport, sub: parts.optimizationReport && this.buildOptimizationReport(parts.optimizationReport) },
      { name: '7. Capacity', done: !!parts.capacityPlan, sub: parts.capacityPlan && this.buildCapacityPlanReport(parts.capacityPlan) },
    ];

    const sections: ReportSection[] = [
      {
        heading: 'Project overview',
        fields: [
          { label: 'Project', value: project.name },
          { label: 'Platform', value: project.platform },
          { label: 'Manual override', value: String(project.platformIsManualOverride) },
        ],
      },
      {
        heading: 'Phase completion',
        tables: [
          {
            headers: ['Phase', 'Status'],
            rows: phases.map((p) => [p.name, p.done ? 'Complete' : 'Not started / no deliverable yet']),
          },
        ],
      },
    ];

    for (const phase of phases) {
      if (phase.sub) {
        sections.push({ heading: `${phase.name}: ${phase.sub.title}`, paragraphs: [phase.sub.subtitle ?? ''] });
        sections.push(...phase.sub.sections);
      }
    }

    return {
      title: 'Complete Assessment Report',
      subtitle: project.name,
      generatedAt: new Date().toISOString(),
      sections,
    };
  }
}
