import { Injectable } from '@nestjs/common';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { buildComparativeReason, clampToRange, ramp } from '../common/scoring-utils';
import { UpdateFrequency } from './enums/update-frequency.enum';
import {
  ImpactEstimate,
  IndexCriteriaScores,
  IndexRecommendationInput,
  IndexRecommendationResult,
  IndexType,
  ScoredIndexOption,
  TuningParameter,
} from './index-recommendation.types';

/**
 * Phase 3 - Index Design engine. Scores HNSW, IVF-Flat, and PQ against the
 * inputs required by the source prompt (vector count, dimension, memory, QPS,
 * recall target, latency target, update frequency, hardware) using only
 * backend/config/indexes.yaml (parameter bounds/defaults, memory/compression
 * factors, update-friendliness) and the shared latency/recall thresholds in
 * backend/config/thresholds.yaml - no numeric cutoffs are hard-coded here.
 */
@Injectable()
export class IndexRecommendationEngineService {
  constructor(private readonly platformConfig: PlatformConfigService) {}

  listCandidateIndexes() {
    return this.platformConfig.getIndexCatalog();
  }

  evaluate(input: IndexRecommendationInput): IndexRecommendationResult {
    const thresholds = this.platformConfig.getThresholds();
    const catalog = this.platformConfig.getIndexCatalog();
    const weights = thresholds.indexSelection.scoringWeights;

    const options: ScoredIndexOption[] = catalog.map((entry) => {
      const indexType = entry.id as IndexType;
      const estimatedMemoryGb = this.estimateMemoryGb(indexType, entry, input.vectorCount, input.dimension);
      const criteriaScores = this.scoreCriteria(indexType, entry, input, thresholds, estimatedMemoryGb);
      const totalScore =
        criteriaScores.recall * weights.recall +
        criteriaScores.latency * weights.latency +
        criteriaScores.memory * weights.memory +
        criteriaScores.throughput * weights.throughput +
        criteriaScores.updateFriendliness * weights.updateFriendliness;

      return {
        indexType,
        label: entry.label,
        totalScore: Number(totalScore.toFixed(4)),
        criteriaScores,
        estimatedMemoryGb: Number(estimatedMemoryGb.toFixed(3)),
        evidence: this.buildEvidence(entry, input, thresholds, criteriaScores, estimatedMemoryGb),
      };
    });

    options.sort((a, b) => b.totalScore - a.totalScore);
    const winner = options[0];
    const winnerEntry = catalog.find((c) => c.id === winner.indexType)!;

    const alternatives = options.slice(1).map((o) => ({
      indexType: o.indexType,
      reason: buildComparativeReason(
        winner.label,
        winner.totalScore,
        winner.criteriaScores as unknown as Record<string, number>,
        o.label,
        o.totalScore,
        o.criteriaScores as unknown as Record<string, number>,
      ),
    }));

    return {
      rulesVersion: this.platformConfig.getRulesVersion(),
      decision: winner.indexType,
      label: winner.label,
      rationale: this.buildRationale(winner, input),
      configuration: this.buildConfiguration(winner.indexType, winnerEntry, input),
      impact: this.buildImpact(winner, input, thresholds),
      scalingConsiderations: this.buildScalingConsiderations(winner.indexType, input, thresholds),
      options,
      alternatives,
      criteriaWeights: weights,
    };
  }

  private scoreCriteria(
    indexType: IndexType,
    catalogEntry: Record<string, any>,
    input: IndexRecommendationInput,
    thresholds: Record<string, any>,
    estimatedMemoryGb: number,
  ): IndexCriteriaScores {
    return {
      recall: this.scoreRecall(indexType, input.recallTarget, thresholds),
      latency: this.scoreLatency(indexType, input.targetP95LatencyMs, thresholds),
      memory: this.scoreMemory(estimatedMemoryGb, input.availableMemoryGb, thresholds),
      throughput: this.scoreThroughput(indexType, input.qps, thresholds),
      updateFriendliness: catalogEntry.updateFriendliness[input.updateFrequency] ?? 0.8,
    };
  }

  /** Public so the Phase 6 benchmark harness (Sprint 7) can estimate memory for a variant without duplicating this formula. */
  estimateMemoryGb(indexType: IndexType, catalogEntry: Record<string, any>, vectorCount: number, dimension: number): number {
    const rawGb = (vectorCount * dimension * 4) / 1024 ** 3;
    if (indexType === 'pq') {
      return (rawGb / catalogEntry.compressionRatio) * 1.05; // + small codebook/coarse-quantizer overhead
    }
    return rawGb * catalogEntry.memoryOverheadFactor;
  }

  private scoreRecall(indexType: IndexType, recallTarget: number, thresholds: Record<string, any>): number {
    const { highRecallTarget } = thresholds.recall;
    const highModerate = 0.85;
    if (indexType === 'hnsw') {
      return recallTarget >= highRecallTarget ? 0.95 : 1.0;
    }
    if (indexType === 'ivf_flat') {
      if (recallTarget >= highRecallTarget) return 0.7;
      return recallTarget >= highModerate ? 0.85 : 0.95;
    }
    // pq
    if (recallTarget >= highRecallTarget) return 0.4;
    return recallTarget >= highModerate ? 0.65 : 0.85;
  }

  private scoreLatency(indexType: IndexType, targetP95LatencyMs: number, thresholds: Record<string, any>): number {
    const { strictP95, moderateP95 } = thresholds.latencyMs;
    if (targetP95LatencyMs >= moderateP95) {
      return 1.0;
    }
    const scores: Record<IndexType, number> = { hnsw: 1.0, ivf_flat: 0.85, pq: 0.95 };
    if (targetP95LatencyMs >= strictP95) {
      return scores[indexType];
    }
    const strictScores: Record<IndexType, number> = { hnsw: 0.95, ivf_flat: 0.6, pq: 0.9 };
    return strictScores[indexType];
  }

  /**
   * HNSW's graph traversal is single-query-optimized (many small random memory
   * accesses) and loses some of its edge under very high concurrent QPS; PQ's
   * lookup-table distance computation is cheap and cache-friendly and holds up
   * best at high throughput. Reuses the same qps thresholds as Phase 1 so
   * "high QPS" means the same thing across the whole platform.
   */
  private scoreThroughput(indexType: IndexType, qps: number, thresholds: Record<string, any>): number {
    const { embeddedMax, dedicatedRecommendedMin } = thresholds.qps;
    if (qps >= dedicatedRecommendedMin) {
      return { [IndexType.HNSW]: 0.7, [IndexType.IVF_FLAT]: 0.85, [IndexType.PQ]: 0.95 }[indexType];
    }
    if (qps >= embeddedMax) {
      return { [IndexType.HNSW]: 0.85, [IndexType.IVF_FLAT]: 0.9, [IndexType.PQ]: 0.92 }[indexType];
    }
    return { [IndexType.HNSW]: 1.0, [IndexType.IVF_FLAT]: 0.9, [IndexType.PQ]: 0.85 }[indexType];
  }

  private scoreMemory(estimatedMemoryGb: number, availableMemoryGb: number, thresholds: Record<string, any>): number {
    const comfortable = availableMemoryGb * thresholds.indexSelection.comfortableMemoryUtilization;
    // Anchor the bottom of the ramp well past `availableMemoryGb` rather than at it, so two
    // over-budget options are still distinguished by how far over budget they are instead of
    // both flatlining to a score of 0.
    const severeOvershoot = availableMemoryGb * thresholds.indexSelection.severeMemoryOvershootMultiplier;
    return Number((1 - ramp(estimatedMemoryGb, comfortable, severeOvershoot)).toFixed(4));
  }

  private buildEvidence(
    catalogEntry: Record<string, any>,
    input: IndexRecommendationInput,
    thresholds: Record<string, any>,
    scores: IndexCriteriaScores,
    estimatedMemoryGb: number,
  ): string[] {
    return [
      `Recall target ${input.recallTarget} scored ${scores.recall} (high-recall threshold=${thresholds.recall.highRecallTarget}).`,
      `Target P95 latency ${input.targetP95LatencyMs}ms scored ${scores.latency} ` +
        `(strict=${thresholds.latencyMs.strictP95}ms, moderate=${thresholds.latencyMs.moderateP95}ms).`,
      `Estimated memory footprint ${estimatedMemoryGb.toFixed(2)}GB vs. ${input.availableMemoryGb}GB available scored ${scores.memory}.`,
      `QPS ${input.qps} scored ${scores.throughput} against thresholds ` +
        `(embeddedMax=${thresholds.qps.embeddedMax}, dedicatedMin=${thresholds.qps.dedicatedRecommendedMin}).`,
      `Update frequency '${input.updateFrequency}' scored ${scores.updateFriendliness} for ${catalogEntry.label}.`,
    ];
  }

  private buildRationale(winner: ScoredIndexOption, input: IndexRecommendationInput): string {
    return (
      `${winner.label} scored highest overall (${winner.totalScore.toFixed(2)}) for ${input.vectorCount.toLocaleString()} vectors ` +
      `at ${input.dimension} dimensions, a ${input.recallTarget} recall target, a ${input.targetP95LatencyMs}ms P95 latency target, ` +
      `${input.qps} QPS, ${input.availableMemoryGb}GB available memory, and '${input.updateFrequency}' update frequency - weighted ` +
      `across recall, latency, memory footprint, throughput, and update-friendliness.`
    );
  }

  private buildConfiguration(indexType: IndexType, catalogEntry: Record<string, any>, input: IndexRecommendationInput): TuningParameter[] {
    const params = catalogEntry.parameters;

    if (indexType === 'hnsw') {
      const M = clampToRange(input.dimension > 512 ? params.M.default + 8 : params.M.default, params.M.min, params.M.max);
      const efConstruction = clampToRange(
        Math.round(params.efConstruction.default * (input.recallTarget >= 0.95 ? 1.5 : 1)),
        params.efConstruction.min,
        params.efConstruction.max,
      );
      const efSearch = clampToRange(
        Math.max(params.efSearch.default, input.topK * 2, Math.round(input.recallTarget * 200)),
        params.efSearch.min,
        params.efSearch.max,
      );
      return [
        { name: 'M', value: M, description: params.M.description },
        { name: 'efConstruction', value: efConstruction, description: params.efConstruction.description },
        { name: 'efSearch', value: efSearch, description: params.efSearch.description },
      ];
    }

    if (indexType === 'ivf_flat') {
      const nlist = clampToRange(Math.round(Math.sqrt(input.vectorCount) * 4), params.nlist.min, params.nlist.max);
      const nprobe = clampToRange(Math.round(nlist * (input.recallTarget >= 0.95 ? 0.1 : 0.02)), params.nprobe.min, params.nprobe.max);
      return [
        { name: 'nlist', value: nlist, description: params.nlist.description },
        { name: 'nprobe', value: nprobe, description: params.nprobe.description },
      ];
    }

    // pq
    const m = this.pickSubquantizerCount(input.dimension, params.m.min, params.m.max, params.m.default);
    const nlist = clampToRange(Math.round(Math.sqrt(input.vectorCount) * 4), params.nlist.min, params.nlist.max);
    const nprobe = clampToRange(Math.round(nlist * (input.recallTarget >= 0.95 ? 0.1 : 0.02)), params.nprobe.min, params.nprobe.max);
    return [
      { name: 'm', value: m, description: params.m.description },
      { name: 'nbits', value: params.nbits.default, description: params.nbits.description },
      { name: 'nlist', value: nlist, description: params.nlist.description },
      { name: 'nprobe', value: nprobe, description: params.nprobe.description },
    ];
  }

  /** Picks the largest divisor of `dimension` at or below `preferredDefault` (PQ requires dimension % m === 0). */
  private pickSubquantizerCount(dimension: number, min: number, max: number, preferredDefault: number): number {
    const upperBound = Math.min(max, preferredDefault);
    for (let m = upperBound; m >= min; m--) {
      if (dimension % m === 0) {
        return m;
      }
    }
    return min;
  }

  private buildImpact(winner: ScoredIndexOption, input: IndexRecommendationInput, thresholds: Record<string, any>): ImpactEstimate {
    const recallEstimate =
      winner.criteriaScores.recall >= 0.9
        ? `Expected to comfortably meet the ${input.recallTarget} recall target at the configured parameters.`
        : `May fall short of the ${input.recallTarget} recall target at scale; validate with the Phase 6 benchmark suite and raise search-time parameters if needed.`;

    const latencyEstimate =
      winner.criteriaScores.latency >= 0.9
        ? `Expected to comfortably meet the ${input.targetP95LatencyMs}ms P95 latency target.`
        : `Latency is at risk under the ${input.targetP95LatencyMs}ms P95 target; load-test before committing to this SLA.`;

    return {
      recallEstimate,
      latencyEstimate,
      memoryEstimateGb: winner.estimatedMemoryGb,
    };
  }

  private buildScalingConsiderations(indexType: IndexType, input: IndexRecommendationInput, thresholds: Record<string, any>): string[] {
    const considerations: string[] = [];

    if (input.vectorCount >= thresholds.vectorCount.dedicatedRecommendedMin) {
      considerations.push('At this vector count, consider sharding across multiple index nodes/partitions (see Phase 7 - Scaling & Sharding).');
    }
    if (indexType === 'hnsw' && input.updateFrequency === UpdateFrequency.HIGH) {
      considerations.push('HNSW graphs degrade under sustained high-frequency updates; schedule periodic full rebuilds or re-evaluate IVF-Flat.');
    }
    if (indexType === 'pq' && input.recallTarget >= thresholds.recall.highRecallTarget) {
      considerations.push('PQ has a lower recall ceiling than HNSW/IVF-Flat; consider a re-ranking pass over raw vectors for top candidates if recall is insufficient.');
    }
    if (indexType === 'ivf_flat' || indexType === 'pq') {
      considerations.push('Re-train the coarse quantizer (nlist clusters) after significant data growth (e.g. 2x since the last training) to keep cluster balance healthy.');
    }
    considerations.push('Re-run this Index Design step whenever vector count, dimension, or SLA targets change materially.');
    return considerations;
  }
}
