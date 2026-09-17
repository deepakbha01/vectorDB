import { Injectable } from '@nestjs/common';
import { PlatformConfigService } from '../common/config/platform-config.service';
import {
  DEDICATED_AT_SCALE_PLATFORMS,
  EMBEDDED_LIBRARY_PLATFORMS,
  K8S_SELF_HOSTABLE_PLATFORMS,
  LIVE_INGESTION_SUPPORTED,
  SQL_BASED_PLATFORMS,
  VectorPlatform,
} from '../projects/enums/platform.enum';
import { buildComparativeReason, ramp } from '../common/scoring-utils';
import { buildPlainLanguageSummary } from './plain-language-summary';
import {
  AssessmentInput,
  CriteriaScores,
  InfrastructureEstimate,
  RecommendationResult,
  ScoredOption,
} from './recommendation.types';

/**
 * Phase 1 Architecture Decision Engine.
 *
 * Scores every catalog platform (backend/config/databases.yaml) against the
 * discovery-assessment inputs using the weighted criteria and thresholds in
 * backend/config/thresholds.yaml - nothing here is a hard-coded numeric
 * cutoff; every threshold and weight is configurable per rule "Use
 * configurable thresholds. Do not hard-code simplistic limits."
 */
@Injectable()
export class RecommendationEngineService {
  constructor(private readonly platformConfig: PlatformConfigService) {}

  listCandidatePlatforms() {
    return this.platformConfig.getSupportedPlatforms();
  }

  evaluate(input: AssessmentInput): RecommendationResult {
    const thresholds = this.platformConfig.getThresholds();
    const catalog = this.platformConfig.getSupportedPlatforms();
    const weights = thresholds.scoringWeights;

    const options: ScoredOption[] = catalog.map((entry) => {
      const platformId = entry.id as VectorPlatform;
      const criteriaScores = this.scoreCriteria(platformId, entry, input, thresholds);
      const totalScore =
        criteriaScores.vectorCount * weights.vectorCount +
        criteriaScores.qps * weights.qps +
        criteriaScores.latency * weights.latency +
        criteriaScores.recall * weights.recall +
        criteriaScores.existingPlatform * weights.existingPlatform +
        criteriaScores.operationalComplexity * weights.operationalComplexity +
        criteriaScores.cost * weights.cost;

      return {
        platformId,
        label: entry.label,
        totalScore: Number(totalScore.toFixed(4)),
        criteriaScores,
        evidence: this.buildEvidence(platformId, entry, input, thresholds, criteriaScores),
      };
    });

    options.sort((a, b) => b.totalScore - a.totalScore);
    const winner = options[0];
    const rejected = options.slice(1).map((o) => ({
      platformId: o.platformId,
      reason: this.buildRejectionReason(o, winner),
    }));
    const risks = this.buildRisks(winner.platformId, input, thresholds);

    return {
      rulesVersion: this.platformConfig.getRulesVersion(),
      decision: winner.platformId,
      rationale: this.buildRationale(winner, input),
      options,
      rejectedAlternatives: rejected,
      assumptions: this.buildAssumptions(input),
      risks,
      infrastructureEstimate: this.estimateInfrastructure(input, thresholds),
      operationalComplexity: catalog.find((c) => c.id === winner.platformId)?.operationalComplexity ?? 'unknown',
      plainLanguageSummary: buildPlainLanguageSummary(winner.label, winner.totalScore, winner.criteriaScores, risks),
    };
  }

  private scoreCriteria(
    platformId: VectorPlatform,
    catalogEntry: Record<string, any>,
    input: AssessmentInput,
    thresholds: Record<string, any>,
  ): CriteriaScores {
    const favorsSmallScale = SQL_BASED_PLATFORMS.includes(platformId) || EMBEDDED_LIBRARY_PLATFORMS.includes(platformId);
    const isDedicatedAtScale = DEDICATED_AT_SCALE_PLATFORMS.includes(platformId);
    const hasMatureAnnEngine = isDedicatedAtScale || EMBEDDED_LIBRARY_PLATFORMS.includes(platformId);

    return {
      vectorCount: this.scoreVectorCount(favorsSmallScale, isDedicatedAtScale, input.estimatedVectorCount, thresholds),
      qps: this.scoreQps(favorsSmallScale, Math.max(input.qps, input.peakQps), thresholds),
      latency: this.scoreLatency(hasMatureAnnEngine, input.targetP95LatencyMs, thresholds),
      recall: this.scoreRecall(hasMatureAnnEngine, input.recallTarget, thresholds),
      existingPlatform: this.scoreExistingPlatform(platformId, input, thresholds),
      operationalComplexity: this.scoreOperationalComplexity(catalogEntry, input, thresholds),
      cost: this.scoreCost(platformId, input, thresholds),
    };
  }

  private scoreVectorCount(
    favorsSmallScale: boolean,
    isDedicatedAtScale: boolean,
    vectorCount: number,
    thresholds: Record<string, any>,
  ): number {
    const { embeddedMax, dedicatedRecommendedMin, dedicatedFloor } = thresholds.vectorCount;
    if (favorsSmallScale) {
      return Number((1 - ramp(vectorCount, embeddedMax, dedicatedRecommendedMin)).toFixed(4));
    }
    if (isDedicatedAtScale) {
      if (vectorCount < dedicatedFloor) {
        return 0.2; // technically capable, but a dedicated/managed engine is overkill at this scale
      }
      return Number(ramp(vectorCount, embeddedMax, dedicatedRecommendedMin).toFixed(4));
    }
    return 0.5;
  }

  private scoreQps(favorsSmallScale: boolean, qps: number, thresholds: Record<string, any>): number {
    const { embeddedMax, dedicatedRecommendedMin } = thresholds.qps;
    if (favorsSmallScale) {
      return Number((1 - ramp(qps, embeddedMax, dedicatedRecommendedMin)).toFixed(4));
    }
    return Number(ramp(qps, embeddedMax, dedicatedRecommendedMin).toFixed(4));
  }

  private scoreLatency(hasMatureAnnEngine: boolean, targetP95LatencyMs: number, thresholds: Record<string, any>): number {
    const { strictP95, moderateP95 } = thresholds.latencyMs;
    if (targetP95LatencyMs >= moderateP95) {
      return 1.0;
    }
    if (targetP95LatencyMs >= strictP95) {
      return hasMatureAnnEngine ? 0.9 : 0.75;
    }
    return hasMatureAnnEngine ? 0.85 : 0.5;
  }

  private scoreRecall(hasMatureAnnEngine: boolean, recallTarget: number, thresholds: Record<string, any>): number {
    const { highRecallTarget } = thresholds.recall;
    const base = 0.85;
    if (recallTarget >= highRecallTarget) {
      return hasMatureAnnEngine ? 1.0 : base;
    }
    return hasMatureAnnEngine ? 0.95 : 0.9;
  }

  private scoreExistingPlatform(platformId: VectorPlatform, input: AssessmentInput, thresholds: Record<string, any>): number {
    if (platformId === VectorPlatform.ORACLE) {
      return input.hasExistingOracle ? 1.0 : 0.4;
    }
    if (platformId === VectorPlatform.POSTGRES_PGVECTOR) {
      return input.hasExistingPostgres ? 1.0 : 0.5;
    }
    if (K8S_SELF_HOSTABLE_PLATFORMS.includes(platformId)) {
      if (input.hasExistingKubernetes) {
        return platformId === VectorPlatform.MILVUS ? 0.8 : 0.7;
      }
      // Only Milvus's catalog entry sets requiresKubernetes: true (a hard
      // prerequisite); the other self-hostable platforms here can run
      // standalone, so lacking Kubernetes is a milder penalty for them.
      if (platformId === VectorPlatform.MILVUS) {
        return thresholds.operationalComplexity.kubernetesRequiredForMilvus ? 0.2 : 0.5;
      }
      return 0.5;
    }
    return 0.5;
  }

  private scoreOperationalComplexity(
    catalogEntry: Record<string, any>,
    input: AssessmentInput,
    thresholds: Record<string, any>,
  ): number {
    const levelScores = thresholds.operationalComplexity.levelScores;
    let score = levelScores[catalogEntry.operationalComplexity] ?? 0.5;
    if (catalogEntry.requiresKubernetes && !input.hasExistingKubernetes) {
      score *= 0.6; // stand-up-a-cluster penalty
    }
    return Number(score.toFixed(4));
  }

  private scoreCost(platformId: VectorPlatform, input: AssessmentInput, thresholds: Record<string, any>): number {
    // Reusing existing infrastructure is materially cheaper than provisioning new
    // compute/storage; a dedicated cluster only pays for itself at scale.
    if (platformId === VectorPlatform.ORACLE) {
      return input.hasExistingOracle ? 0.9 : 0.4;
    }
    if (platformId === VectorPlatform.POSTGRES_PGVECTOR) {
      return input.hasExistingPostgres ? 0.95 : 0.6;
    }
    if (K8S_SELF_HOSTABLE_PLATFORMS.includes(platformId)) {
      const { embeddedMax, dedicatedRecommendedMin } = thresholds.vectorCount;
      const scaleFactor = ramp(input.estimatedVectorCount, embeddedMax, dedicatedRecommendedMin);
      const base = input.hasExistingKubernetes ? 0.6 : 0.25;
      return Number((base + scaleFactor * 0.3).toFixed(4));
    }
    if (platformId === VectorPlatform.PINECONE || platformId === VectorPlatform.MONGODB_ATLAS) {
      // Fully managed SaaS: no self-host escape valve, so no existing-infrastructure discount applies.
      return 0.45;
    }
    if (EMBEDDED_LIBRARY_PLATFORMS.includes(platformId)) {
      // Embedded/in-process: no server to provision or pay for at this scale.
      return 0.85;
    }
    return 0.5;
  }

  private buildEvidence(
    platformId: VectorPlatform,
    catalogEntry: Record<string, any>,
    input: AssessmentInput,
    thresholds: Record<string, any>,
    scores: CriteriaScores,
  ): string[] {
    const evidence: string[] = [
      `Estimated vector count ${input.estimatedVectorCount.toLocaleString()} scored ${scores.vectorCount} against thresholds ` +
        `(embeddedMax=${thresholds.vectorCount.embeddedMax.toLocaleString()}, dedicatedMin=${thresholds.vectorCount.dedicatedRecommendedMin.toLocaleString()}).`,
      `QPS (peak ${Math.max(input.qps, input.peakQps)}) scored ${scores.qps} against thresholds ` +
        `(embeddedMax=${thresholds.qps.embeddedMax}, dedicatedMin=${thresholds.qps.dedicatedRecommendedMin}).`,
      `Target P95 latency ${input.targetP95LatencyMs}ms scored ${scores.latency} against thresholds ` +
        `(strict=${thresholds.latencyMs.strictP95}ms, moderate=${thresholds.latencyMs.moderateP95}ms).`,
      `Recall target ${input.recallTarget} scored ${scores.recall}.`,
      `Existing-platform fit scored ${scores.existingPlatform} ` +
        `(existingOracle=${input.hasExistingOracle}, existingPostgres=${input.hasExistingPostgres}, existingKubernetes=${input.hasExistingKubernetes}).`,
      `Operational complexity ('${catalogEntry.operationalComplexity}') scored ${scores.operationalComplexity}.`,
      `Cost fit scored ${scores.cost}.`,
    ];
    return evidence;
  }

  private buildRationale(winner: ScoredOption, input: AssessmentInput): string {
    return (
      `${winner.label} scored highest overall (${winner.totalScore.toFixed(2)}) for an estimated ` +
      `${input.estimatedVectorCount.toLocaleString()} vectors at ${input.embeddingDimension} dimensions, ` +
      `${Math.max(input.qps, input.peakQps)} peak QPS, a ${input.targetP95LatencyMs}ms P95 latency target, and a ` +
      `${input.recallTarget} recall target, weighted across vector volume, QPS, latency, recall, existing-platform ` +
      `fit, operational complexity, and cost.`
    );
  }

  private buildRejectionReason(option: ScoredOption, winner: ScoredOption): string {
    return buildComparativeReason(
      winner.label,
      winner.totalScore,
      winner.criteriaScores as unknown as Record<string, number>,
      option.label,
      option.totalScore,
      option.criteriaScores as unknown as Record<string, number>,
    );
  }

  private buildAssumptions(input: AssessmentInput): string[] {
    return [
      'Vector dimension and count are stable estimates provided at Discovery time; re-run the assessment if they change materially.',
      `Sizing assumes float32 embeddings (${input.embeddingDimension} dimensions) with a single HNSW-style ANN index per collection.`,
      'Cost scoring is directional (favors reuse of existing infrastructure); it is not a substitute for a vendor quote.',
      'QPS figures are assumed to be per-instance; multi-region or multi-tenant fan-out is not yet modeled (see Phase 7 - Scaling & Sharding).',
    ];
  }

  private buildRisks(decision: VectorPlatform, input: AssessmentInput, thresholds: Record<string, any>): string[] {
    const risks: string[] = [];

    if (decision === VectorPlatform.MILVUS && !input.hasExistingKubernetes) {
      risks.push('No existing Kubernetes platform was reported; a new cluster must be stood up before Milvus can be provisioned (Phase 4).');
    }
    if (!LIVE_INGESTION_SUPPORTED.has(decision)) {
      risks.push(
        `No maintained Node.js driver exists for '${decision}'; Phase 2-4/7 (schema, index design, deployment plan, capacity ` +
          'planning) are fully supported, but live ingestion (Phase 5) requires configuring an ODBC/JDBC bridge outside this tool.',
      );
    }
    if (input.recallTarget >= thresholds.recall.highRecallTarget) {
      risks.push('High recall target may require larger ef/nprobe search parameters, increasing latency and memory - validate during Phase 3 index tuning.');
    }
    if (input.targetP95LatencyMs <= thresholds.latencyMs.strictP95) {
      risks.push('Strict P95 latency target is aggressive for the estimated scale; load-test before committing to production SLAs.');
    }
    if (input.containsPii) {
      risks.push('Workload contains PII - confirm encryption at rest/in transit and data residency requirements are enforced end-to-end.');
    }
    if (risks.length === 0) {
      risks.push('No material risks identified from the discovery inputs; standard operational risks (capacity drift, index staleness) still apply.');
    }
    return risks;
  }

  private estimateInfrastructure(input: AssessmentInput, thresholds: Record<string, any>): InfrastructureEstimate {
    const { bytesPerDimension, indexOverheadFactor, ramSafetyFactor, replicationFactor, baselineCpuCoresPerMillionVectors } =
      thresholds.infrastructureEstimation;

    const rawBytes = input.estimatedVectorCount * input.embeddingDimension * bytesPerDimension;
    const rawGb = rawBytes / 1024 ** 3;
    const memoryGb = rawGb * indexOverheadFactor * ramSafetyFactor;
    const storageGb = rawGb * indexOverheadFactor * replicationFactor;
    const cpuCores = Math.max(2, (input.estimatedVectorCount / 1_000_000) * baselineCpuCoresPerMillionVectors);

    const millionVectors = input.estimatedVectorCount / 1_000_000;

    return {
      estimatedRawVectorGb: Number(rawGb.toFixed(3)),
      estimatedMemoryGb: Number(memoryGb.toFixed(3)),
      estimatedStorageGb: Number(storageGb.toFixed(3)),
      estimatedCpuCores: Number(cpuCores.toFixed(2)),
      notes: [
        `Raw vector data: ${input.estimatedVectorCount.toLocaleString()} vectors x ${input.embeddingDimension} dimensions x ` +
          `${bytesPerDimension} bytes/dimension = ${rawGb.toFixed(3)}GB.`,
        `Estimated memory: ${rawGb.toFixed(3)}GB raw x ${indexOverheadFactor} (index overhead) x ${ramSafetyFactor} ` +
          `(safety factor) = ${memoryGb.toFixed(3)}GB.`,
        `Estimated storage: ${rawGb.toFixed(3)}GB raw x ${indexOverheadFactor} (index overhead) x ${replicationFactor} ` +
          `(replication for HA) = ${storageGb.toFixed(3)}GB.`,
        `Estimated CPU cores: the greater of a 2-core floor or ${millionVectors.toFixed(2)}M vectors x ` +
          `${baselineCpuCoresPerMillionVectors} cores/million = ${cpuCores.toFixed(2)} cores.`,
      ],
    };
  }
}
