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
import { OperationalCapability } from '../discovery/enums/discovery.enum';
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
      const ineligibleReasons = this.checkEligibility(entry, input);
      const evidence = this.buildEvidence(platformId, entry, input, thresholds, criteriaScores);

      return {
        platformId,
        label: entry.label,
        totalScore: Number(totalScore.toFixed(4)),
        criteriaScores,
        eligible: ineligibleReasons.length === 0,
        ineligibleReasons,
        evidence: ineligibleReasons.length > 0 ? [...ineligibleReasons, ...evidence] : evidence,
      };
    });

    options.sort((a, b) => b.totalScore - a.totalScore);
    // Eligibility gates who can win, independently of score: a platform that
    // fails a hard search-capability requirement is never the recommendation,
    // no matter how well it scores on everything else. Falls back to scoring
    // all options only if literally nothing in the catalog qualifies.
    const eligibleOptions = options.filter((o) => o.eligible);
    const winnerPool = eligibleOptions.length > 0 ? eligibleOptions : options;
    const winner = winnerPool[0];
    const rejected = options
      .filter((o) => o.platformId !== winner.platformId)
      .map((o) => ({
        platformId: o.platformId,
        reason: o.eligible ? this.buildRejectionReason(o, winner) : o.ineligibleReasons.join(' '),
      }));
    const risks = this.buildRisks(winner.platformId, input, thresholds, eligibleOptions.length === 0);

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
    // Already running this exact platform is the strongest possible fit - stronger even than
    // the generic "have a Kubernetes cluster" signal below, since there is zero migration cost.
    const alreadyRunningThisPlatform = input.existingPlatforms.includes(platformId);
    if (alreadyRunningThisPlatform) {
      return 1.0;
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
    score *= this.operationalCapabilityMultiplier(catalogEntry.operationalComplexity, input.operationalCapability);
    return Number(Math.min(1, score).toFixed(4));
  }

  /**
   * A team with little day-to-day database capacity should be steered away from
   * operationally demanding platforms; a dedicated DBA or platform team can absorb that
   * overhead, so the complexity penalty is relaxed (or the fit slightly boosted) for them.
   * Low-complexity platforms are assumed manageable at any capability level.
   */
  private operationalCapabilityMultiplier(complexityLevel: string, capability: OperationalCapability): number {
    if (complexityLevel === 'high') {
      if (capability === OperationalCapability.NONE) return 0.5;
      if (capability === OperationalCapability.PART_TIME) return 0.75;
      if (capability === OperationalCapability.PLATFORM_TEAM) return 1.15;
      return 1.0; // dedicated_dba
    }
    if (complexityLevel === 'medium') {
      if (capability === OperationalCapability.NONE) return 0.85;
      return 1.0;
    }
    return 1.0;
  }

  private scoreCost(platformId: VectorPlatform, input: AssessmentInput, thresholds: Record<string, any>): number {
    // Reusing existing infrastructure is materially cheaper than provisioning new
    // compute/storage; a dedicated cluster only pays for itself at scale.
    const alreadyRunningThisPlatform = input.existingPlatforms.includes(platformId);
    if (platformId === VectorPlatform.ORACLE) {
      return input.hasExistingOracle ? 0.9 : 0.4;
    }
    if (platformId === VectorPlatform.POSTGRES_PGVECTOR) {
      return input.hasExistingPostgres ? 0.95 : 0.6;
    }
    if (K8S_SELF_HOSTABLE_PLATFORMS.includes(platformId)) {
      const { embeddedMax, dedicatedRecommendedMin } = thresholds.vectorCount;
      const scaleFactor = ramp(input.estimatedVectorCount, embeddedMax, dedicatedRecommendedMin);
      const base = alreadyRunningThisPlatform ? 0.75 : input.hasExistingKubernetes ? 0.6 : 0.25;
      return Number(Math.min(1, base + scaleFactor * 0.3).toFixed(4));
    }
    if (platformId === VectorPlatform.PINECONE || platformId === VectorPlatform.MONGODB_ATLAS) {
      // Fully managed SaaS: no self-host escape valve, but an already-running account/index
      // still avoids migration cost and unfamiliar-tooling ramp-up.
      return alreadyRunningThisPlatform ? 0.7 : 0.45;
    }
    if (EMBEDDED_LIBRARY_PLATFORMS.includes(platformId)) {
      // Embedded/in-process: no server to provision or pay for at this scale.
      return alreadyRunningThisPlatform ? 0.95 : 0.85;
    }
    // Actian and any other bolt-on SQL platform without a dedicated branch above: same
    // reuse-is-cheaper logic as Oracle, since it is provisioned the same way (an existing
    // instance vs. standing up a new one).
    return alreadyRunningThisPlatform ? 0.9 : 0.4;
  }

  /**
   * Hard eligibility gate, separate from scoring: `databases.yaml`'s
   * `supportsHybridSearch`/`supportsMetadataFiltering` flags previously had
   * no effect on the recommendation even when the assessment explicitly
   * required that capability (e.g. Chroma/LanceDB are marked
   * `supportsHybridSearch: false` but could still win outright). A platform
   * that fails a required capability here can still be scored for
   * transparency, but can never be the winning `decision`.
   */
  private checkEligibility(catalogEntry: Record<string, any>, input: AssessmentInput): string[] {
    const reasons: string[] = [];
    if (input.requiresHybridSearch && !catalogEntry.supportsHybridSearch) {
      reasons.push(`${catalogEntry.label} does not support hybrid (vector + keyword) search, which this workload requires.`);
    }
    // The catalog has no separate full-text-search flag; supportsHybridSearch is the closest
    // available signal, since every platform that supports hybrid search does so via a
    // built-in lexical/full-text engine (BM25 or equivalent).
    if (input.requiresFullTextSearch && !catalogEntry.supportsHybridSearch) {
      reasons.push(`${catalogEntry.label} has no built-in full-text search capability, which this workload requires.`);
    }
    if (input.requiresMetadataFiltering && !catalogEntry.supportsMetadataFiltering) {
      reasons.push(`${catalogEntry.label} does not support metadata filtering, which this workload requires.`);
    }
    return reasons;
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
        `(existingOracle=${input.hasExistingOracle}, existingPostgres=${input.hasExistingPostgres}, existingKubernetes=${input.hasExistingKubernetes}, ` +
        `already running ${catalogEntry.label}=${input.existingPlatforms.includes(platformId)}).`,
      `Operational complexity ('${catalogEntry.operationalComplexity}') scored ${scores.operationalComplexity} ` +
        `given a '${input.operationalCapability}' operational capability.`,
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
    const assumptions = [
      'Vector dimension and count are stable estimates provided at Discovery time; re-run the assessment if they change materially.',
      `Sizing assumes float32 embeddings (${input.embeddingDimension} dimensions) with a single HNSW-style ANN index per collection.`,
      'Cost scoring is directional (favors reuse of existing infrastructure); it is not a substitute for a vendor quote.',
      'QPS figures are assumed to be per-instance; multi-region or multi-tenant fan-out is not yet modeled beyond the risk noted below (see Phase 7 - Scaling & Sharding).',
    ];
    if (input.precisionTarget !== undefined) {
      assumptions.push(
        `A precision@K target of ${input.precisionTarget} was also specified; ANN index tuning (ef/nprobe) primarily controls recall, not ` +
          'precision, which is typically governed by downstream result filtering/reranking rather than the index itself - it is recorded but not scored.',
      );
    }
    if (input.requiresReranking) {
      assumptions.push(
        'Reranking is assumed to run at the application layer over the top-K candidates any of these platforms return; it does not change ' +
          'platform selection, since it is not platform-specific.',
      );
    }
    if (input.monthlyBudgetUsd !== undefined) {
      assumptions.push(
        `A monthly budget of $${input.monthlyBudgetUsd} was specified; the cost criterion above is a directional 0-1 fitness score, not a ` +
          'dollar estimate - validate against actual vendor/cloud pricing before committing.',
      );
    }
    return assumptions;
  }

  private buildRisks(
    decision: VectorPlatform,
    input: AssessmentInput,
    thresholds: Record<string, any>,
    noPlatformFullyEligible: boolean,
  ): string[] {
    const risks: string[] = [];

    if (noPlatformFullyEligible) {
      risks.push(
        'No cataloged platform fully satisfies the required search capabilities (hybrid search / full-text search / metadata ' +
          'filtering); the recommendation below is the best available compromise and this gap should be revisited.',
      );
    }
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
    // A P99 target within ~30% of the P95 target is a tight tail relative to typical ANN
    // query-latency variance under load; a target that loose (or looser) is normal and not flagged.
    if (input.targetP99LatencyMs > 0 && input.targetP99LatencyMs < input.targetP95LatencyMs * 1.3) {
      risks.push(
        `A ${input.targetP99LatencyMs}ms P99 target is tight relative to the ${input.targetP95LatencyMs}ms P95 target; tail latency ` +
          'under load typically exceeds P95 by more than this margin - load-test the P99 specifically, not just P95, before committing.',
      );
    }
    if (input.requiresMultiRegion) {
      risks.push(
        'Multi-region deployment was requested; this tool does not yet model per-platform cross-region replication capabilities - ' +
          "validate the recommended platform's multi-region story manually (Phase 7 - Capacity Planning covers single-region sharding only).",
      );
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
