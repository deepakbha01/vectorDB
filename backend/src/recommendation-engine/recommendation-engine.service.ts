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
  AlternativeBucket,
  AssessmentInput,
  BudgetFeasibility,
  ComplianceCheck,
  ComplianceGateResult,
  ConfidenceLevel,
  CriteriaScores,
  DecisionStatus,
  EligibilityStatus,
  InfrastructureEstimate,
  RankedAlternative,
  RecommendationResult,
  ScoredOption,
  SensitivityResult,
  SensitivityScenario,
} from './recommendation.types';

/**
 * Phase 1 Architecture Decision Engine.
 *
 * Scores every catalog platform (backend/config/databases.yaml) against the
 * discovery-assessment inputs using the weighted criteria and thresholds in
 * backend/config/thresholds.yaml - nothing here is a hard-coded numeric
 * cutoff; every threshold and weight is configurable per rule "Use
 * configurable thresholds. Do not hard-code simplistic limits."
 *
 * Pipeline: score every candidate -> gate eligibility (hard requirements
 * disqualify; requirements this tool can't verify per-platform, like
 * multi-region replication, mark "unverified" rather than silently assuming
 * pass) -> pick a winner from eligible-or-unverified candidates, detecting
 * and deterministically breaking ties -> run the budget and compliance
 * validation gates -> assemble a decision status/confidence so the caller
 * never has to infer "is this actually settled?" from the raw score alone.
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
      const { status: eligibilityStatus, notes: eligibilityNotes } = this.checkEligibility(entry, input);
      const evidence = this.buildEvidence(platformId, entry, input, thresholds, criteriaScores);

      return {
        platformId,
        label: entry.label,
        totalScore: Number(totalScore.toFixed(4)),
        criteriaScores,
        eligibilityStatus,
        eligibilityNotes,
        evidence: eligibilityNotes.length > 0 ? [...eligibilityNotes, ...evidence] : evidence,
      };
    });

    options.sort((a, b) => b.totalScore - a.totalScore);

    // A hard-ineligible platform can never win, no matter its score. An
    // "unverified" platform (e.g. every platform when multi-region is
    // required, since none is modeled per-platform) can still win, but the
    // decision is then marked "conditional" rather than "single" below.
    const eligibleOptions = options.filter((o) => o.eligibilityStatus !== 'ineligible');
    const winnerPool = eligibleOptions.length > 0 ? eligibleOptions : options;

    const tieEpsilon = thresholds.decisionModel.tieEpsilon;
    const topScore = winnerPool[0].totalScore;
    const tied = winnerPool.filter((o) => topScore - o.totalScore <= tieEpsilon);

    const { winner, tieBreakStage } = this.resolveWinner(tied, winnerPool);

    const rejected = this.buildRankedAlternatives(options, winner, tied, thresholds);

    const budgetFeasibility = this.buildBudgetFeasibility(winner.platformId, input);
    const complianceGate = this.buildComplianceGate(input);
    const risks = this.buildRisks(winner.platformId, input, thresholds, eligibleOptions.length === 0);

    const decisionStatus = this.buildDecisionStatus(tied, winner, complianceGate);
    const openValidations = this.buildOpenValidations(input, budgetFeasibility, complianceGate, winner);
    const confidence = this.buildConfidence(decisionStatus, openValidations.length, winner.eligibilityStatus);

    return {
      rulesVersion: this.platformConfig.getRulesVersion(),
      decision: winner.platformId,
      rationale: this.buildRationale(winner, input, tied),
      options,
      rejectedAlternatives: rejected,
      assumptions: this.buildAssumptions(input),
      risks,
      infrastructureEstimate: this.estimateInfrastructure(input, thresholds),
      operationalComplexity: catalog.find((c) => c.id === winner.platformId)?.operationalComplexity ?? 'unknown',
      plainLanguageSummary: buildPlainLanguageSummary(
        winner.label,
        winner.totalScore,
        winner.criteriaScores,
        risks,
        thresholds.decisionModel.verdict,
        openValidations,
        decisionStatus,
        tied.length > 1 ? tied.map((o) => o.label) : [],
      ),
      criteriaWeights: weights,
      decisionStatus,
      confidence,
      tiedPlatformIds: tied.length > 1 ? tied.map((o) => o.platformId) : [],
      tieBreakStage,
      openValidations,
      budgetFeasibility,
      complianceGate,
    };
  }

  /**
   * Re-runs `evaluate()` once per scenario with the given field overrides applied on top of
   * `baseInput`, so a caller can answer "what changes if QPS doubles / budget halves / multi-
   * region becomes mandatory?" without hand-rolling the comparison. Pure and stateless, like
   * `evaluate()` itself - no scenario here is persisted.
   */
  runSensitivityAnalysis(baseInput: AssessmentInput, scenarios: SensitivityScenario[]): SensitivityResult[] {
    const baseline = this.evaluate(baseInput);
    return scenarios.map((scenario) => {
      const result = this.evaluate({ ...baseInput, ...scenario.overrides });
      const decisionOption = result.options.find((o) => o.platformId === result.decision)!;
      return {
        scenario: scenario.name,
        decision: result.decision,
        decisionChanged: result.decision !== baseline.decision,
        totalScore: decisionOption.totalScore,
        decisionStatus: result.decisionStatus,
      };
    });
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
   * Hard-vs-unverified-vs-clean eligibility gate, separate from scoring.
   * `databases.yaml`'s `supportsHybridSearch`/`supportsMetadataFiltering` flags previously
   * had no effect on the recommendation even when the assessment explicitly required that
   * capability. A platform that fails a required capability here is `ineligible` and can
   * never win. Multi-region is a different kind of gap: this tool does not model any
   * platform's cross-region replication story, so instead of silently treating every
   * platform as if it were single-region-capable, every platform is marked `unverified`
   * when multi-region is required - still winnable, but never presented as unconditionally
   * clean (see `buildDecisionStatus`).
   */
  private checkEligibility(catalogEntry: Record<string, any>, input: AssessmentInput): { status: EligibilityStatus; notes: string[] } {
    const hardFailures: string[] = [];
    if (input.requiresHybridSearch && !catalogEntry.supportsHybridSearch) {
      hardFailures.push(`${catalogEntry.label} does not support hybrid (vector + keyword) search, which this workload requires.`);
    }
    // The catalog has no separate full-text-search flag; supportsHybridSearch is the closest
    // available signal, since every platform that supports hybrid search does so via a
    // built-in lexical/full-text engine (BM25 or equivalent).
    if (input.requiresFullTextSearch && !catalogEntry.supportsHybridSearch) {
      hardFailures.push(`${catalogEntry.label} has no built-in full-text search capability, which this workload requires.`);
    }
    if (input.requiresMetadataFiltering && !catalogEntry.supportsMetadataFiltering) {
      hardFailures.push(`${catalogEntry.label} does not support metadata filtering, which this workload requires.`);
    }
    if (hardFailures.length > 0) {
      return { status: 'ineligible', notes: hardFailures };
    }

    const unverifiedNotes: string[] = [];
    if (input.requiresMultiRegion) {
      unverifiedNotes.push(
        `Multi-region deployment was required, but ${catalogEntry.label}'s cross-region replication capability is not modeled by this tool - eligibility is unverified, not assumed.`,
      );
    }
    if (unverifiedNotes.length > 0) {
      return { status: 'unverified', notes: unverifiedNotes };
    }

    return { status: 'eligible', notes: [] };
  }

  /**
   * Deterministic tie-break chain, applied only when 2+ candidates are within the tie
   * epsilon of the top score: prefer the raw (unweighted) cost score, then raw
   * existing-platform score, then raw operational-complexity score, then finally catalog
   * order (stable, so the same inputs always resolve the same winner). Each stage that
   * actually distinguishes the tied set is reported in `tieBreakStage` for full
   * transparency in the output, rather than silently picking one.
   */
  private resolveWinner(tied: ScoredOption[], winnerPool: ScoredOption[]): { winner: ScoredOption; tieBreakStage: string | null } {
    if (tied.length <= 1) {
      return { winner: winnerPool[0], tieBreakStage: null };
    }

    const stages: Array<{ name: string; key: keyof CriteriaScores }> = [
      { name: 'cost / budget feasibility (raw cost fit)', key: 'cost' },
      { name: 'existing-stack alignment (raw score)', key: 'existingPlatform' },
      { name: 'operational model fit (raw score)', key: 'operationalComplexity' },
    ];

    for (const stage of stages) {
      const best = Math.max(...tied.map((o) => o.criteriaScores[stage.key]));
      const stillTied = tied.filter((o) => o.criteriaScores[stage.key] === best);
      if (stillTied.length === 1) {
        return { winner: stillTied[0], tieBreakStage: stage.name };
      }
      if (stillTied.length < tied.length) {
        // Narrowed but not resolved - keep narrowing with the reduced set.
        tied = stillTied;
      }
    }

    return {
      winner: tied[0],
      tieBreakStage: 'catalog order (tied through every tie-break stage; route to architect review or use "Manually override this decision")',
    };
  }

  private buildRankedAlternatives(
    options: ScoredOption[],
    winner: ScoredOption,
    tied: ScoredOption[],
    thresholds: Record<string, any>,
  ): RankedAlternative[] {
    const tiedIds = new Set(tied.length > 1 ? tied.map((o) => o.platformId) : []);
    const strongAlternativeGap = thresholds.decisionModel.strongAlternativeGap;

    return options
      .filter((o) => o.platformId !== winner.platformId)
      .map((o) => {
        if (o.eligibilityStatus === 'ineligible') {
          return { platformId: o.platformId, reason: o.eligibilityNotes.join(' '), bucket: 'capacity_constraint' as AlternativeBucket };
        }
        if (tiedIds.has(o.platformId)) {
          return {
            platformId: o.platformId,
            reason: `${o.label} tied ${winner.label} at ${o.totalScore.toFixed(2)} under the current scoring model; not differentiated by the tie-break chain applied.`,
            bucket: 'tied' as AlternativeBucket,
          };
        }
        const gap = winner.totalScore - o.totalScore;
        const bucket: AlternativeBucket = gap <= strongAlternativeGap ? 'strong' : 'lower_fit';
        const reason = buildComparativeReason(
          winner.label,
          winner.totalScore,
          winner.criteriaScores as unknown as Record<string, number>,
          o.label,
          o.totalScore,
          o.criteriaScores as unknown as Record<string, number>,
        );
        return { platformId: o.platformId, reason, bucket };
      });
  }

  /**
   * This tool has no verified vendor pricing model, so it never fabricates a dollar
   * figure - the fix is to stop implying budget fit from the 0-1 cost score, not to
   * invent a number. Only emitted when a budget was actually specified.
   */
  private buildBudgetFeasibility(decision: VectorPlatform, input: AssessmentInput): BudgetFeasibility | null {
    if (input.monthlyBudgetUsd === undefined) {
      return null;
    }
    return {
      monthlyBudgetUsd: input.monthlyBudgetUsd,
      status: 'not_yet_estimated',
      estimatedMonthlyCostUsd: null,
      note:
        `A monthly budget of $${input.monthlyBudgetUsd} was specified. This tool's cost criterion (used in scoring above) is a ` +
        'directional 0-1 fitness score, not a dollar estimate, so it cannot yet be compared against the budget - get an actual ' +
        "vendor/cloud quote before treating this decision as budget-confirmed.",
    };
  }

  /**
   * Runs only when the workload contains PII. Checks the compliance-relevant inputs the
   * assessment actually captures; "satisfied" here means the requirement was captured as
   * needed by the user, not that this tool has verified the target platform enforces it -
   * that distinction is exactly why the gate caps the badge at "Conditionally eligible"
   * rather than "Excellent Fit" when anything is missing.
   */
  private buildComplianceGate(input: AssessmentInput): ComplianceGateResult {
    if (!input.containsPii) {
      return { applicable: false, status: 'not_applicable', checks: [] };
    }
    const checks: ComplianceCheck[] = [
      { control: 'Encryption at rest', satisfied: input.requiresEncryptionAtRest ?? false },
      { control: 'Encryption in transit', satisfied: input.requiresEncryptionInTransit ?? false },
      { control: 'Data residency', satisfied: !!input.dataResidencyRequirement },
      { control: 'Key management', satisfied: input.requiresKeyManagement },
      { control: 'Access control', satisfied: (input.requiresAuthentication ?? false) && (input.requiresRbac ?? false) },
      { control: 'Audit logging', satisfied: input.requiresAuditLogging },
      { control: 'Tenant isolation', satisfied: input.requiresTenantIsolation },
      { control: 'Backup protection', satisfied: input.rpoMinutes !== undefined && input.rtoMinutes !== undefined },
      { control: 'Retention / deletion policy', satisfied: (input.retentionDays ?? 0) > 0 },
    ];
    const status = checks.every((c) => c.satisfied) ? 'passed' : 'unverified';
    return { applicable: true, status, checks };
  }

  private buildDecisionStatus(tied: ScoredOption[], winner: ScoredOption, complianceGate: ComplianceGateResult): DecisionStatus {
    if (tied.length > 1) {
      return 'tied';
    }
    if (winner.eligibilityStatus === 'unverified' || complianceGate.status === 'unverified') {
      return 'conditional';
    }
    return 'single';
  }

  private buildOpenValidations(
    input: AssessmentInput,
    budgetFeasibility: BudgetFeasibility | null,
    complianceGate: ComplianceGateResult,
    winner: ScoredOption,
  ): string[] {
    const items: string[] = [];
    if (budgetFeasibility && budgetFeasibility.status === 'not_yet_estimated') {
      items.push(`Actual monthly cost vs. the $${budgetFeasibility.monthlyBudgetUsd} stated budget (currently a directional score, not a quote)`);
    }
    if (winner.eligibilityStatus === 'unverified') {
      items.push("Multi-region deployment and replication model for the recommended platform (not yet scored per platform)");
    }
    if (complianceGate.status === 'unverified') {
      const missing = complianceGate.checks.filter((c) => !c.satisfied).map((c) => c.control);
      items.push(`Compliance controls for PII not yet captured: ${missing.join(', ')}`);
    }
    if (input.qpsScope === undefined) {
      items.push('Aggregate vs. per-region vs. per-index QPS definition');
    }
    return items;
  }

  private buildConfidence(decisionStatus: DecisionStatus, openValidationCount: number, eligibilityStatus: EligibilityStatus): ConfidenceLevel {
    if (decisionStatus === 'tied') {
      return 'low';
    }
    if (decisionStatus === 'conditional' || openValidationCount >= 2 || eligibilityStatus === 'unverified') {
      return 'medium';
    }
    return 'high';
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
      `Operational simplicity ('${catalogEntry.operationalComplexity}' complexity) scored ${scores.operationalComplexity} ` +
        `given a '${input.operationalCapability}' operational capability.`,
      `Cost fit scored ${scores.cost}.`,
    ];
    return evidence;
  }

  private buildRationale(winner: ScoredOption, input: AssessmentInput, tied: ScoredOption[]): string {
    const base =
      `${winner.label} scored highest overall (${winner.totalScore.toFixed(2)}) for an estimated ` +
      `${input.estimatedVectorCount.toLocaleString()} vectors at ${input.embeddingDimension} dimensions, ` +
      `${Math.max(input.qps, input.peakQps)} peak QPS, a ${input.targetP95LatencyMs}ms P95 latency target, and a ` +
      `${input.recallTarget} recall target, weighted across vector volume, QPS, latency, recall, existing-platform ` +
      `fit, operational complexity, and cost.`;
    if (tied.length <= 1) {
      return base;
    }
    const others = tied.filter((o) => o.platformId !== winner.platformId).map((o) => o.label);
    return (
      `${winner.label} tied with ${others.join(', ')} at ${winner.totalScore.toFixed(2)} under the current scoring model; ` +
      `${winner.label} was selected via the deterministic tie-break chain. ` +
      base
    );
  }

  private buildAssumptions(input: AssessmentInput): string[] {
    const assumptions = [
      'Vector dimension and count are stable estimates provided at Discovery time; re-run the assessment if they change materially.',
      `Sizing assumes float32 embeddings (${input.embeddingDimension} dimensions) with a single HNSW-style ANN index per collection.`,
      'Cost scoring is directional (favors reuse of existing infrastructure); it is not a substitute for a vendor quote.',
      `QPS figures are treated as '${input.qpsScope}'; if that does not match how you actually measure QPS, re-run the assessment with the correct scope, since it materially changes sizing once multi-region is in play.`,
    ];
    if (input.precisionTarget !== undefined) {
      assumptions.push(
        `A precision@K target of ${input.precisionTarget} was also specified; ANN index tuning (ef/nprobe) primarily controls recall, not ` +
          'precision, which is typically governed by downstream result filtering/reranking rather than the index itself - it is recorded but not scored.',
      );
    }
    if (input.ndcgTarget !== undefined || input.mrrTarget !== undefined) {
      assumptions.push(
        'NDCG@K / MRR targets, if specified, are recorded for the record only - this engine\'s rules only model recall@K, so ranking-quality ' +
          'metrics are not independently scored.',
      );
    }
    if (input.requiresReranking) {
      assumptions.push(
        'Reranking is assumed to run at the application layer over the top-K candidates any of these platforms return; it does not change ' +
          'platform selection, since it is not platform-specific.',
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
    if (input.precisionTarget !== undefined && input.precisionTarget >= 0.99) {
      risks.push(
        `A precision@K target of ${input.precisionTarget} is at or near the ceiling; confirm this is intentional (e.g. "near-exhaustive search ` +
          'required") rather than a proxy for "very high precision" entered as literal 100%, since the two imply very different index designs.',
      );
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
        // Binary units (1024^3), so labeled GiB rather than the decimal-GB figure that
        // number would imply - a real unit-labeling mismatch a prior review caught.
        `Raw vector data: ${input.estimatedVectorCount.toLocaleString()} vectors x ${input.embeddingDimension} dimensions x ` +
          `${bytesPerDimension} bytes/dimension = ${rawGb.toFixed(3)}GiB.`,
        `Estimated memory: ${rawGb.toFixed(3)}GiB raw x ${indexOverheadFactor} (index overhead) x ${ramSafetyFactor} ` +
          `(safety factor) = ${memoryGb.toFixed(3)}GiB.`,
        `Estimated storage: ${rawGb.toFixed(3)}GiB raw x ${indexOverheadFactor} (index overhead) x ${replicationFactor} ` +
          `(replication for HA) = ${storageGb.toFixed(3)}GiB.`,
        `Estimated CPU cores: the greater of a 2-core floor or ${millionVectors.toFixed(2)}M vectors x ` +
          `${baselineCpuCoresPerMillionVectors} cores/million = ${cpuCores.toFixed(2)} cores.`,
      ],
    };
  }
}
