import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { DiscoveryAssessment } from '../discovery/discovery-assessment.entity';
import { VectorPlatform } from '../projects/enums/platform.enum';
import {
  AssumptionEntry,
  BudgetFeasibility,
  ComplianceGateResult,
  ConfidenceLevel,
  CriteriaScores,
  DecisionStatus,
  InfrastructureEstimate,
  PlainLanguageSummary,
  RankedAlternative,
  RetrievalStrategyResult,
  RiskEntry,
  ScoredOption,
} from '../recommendation-engine/recommendation.types';

/**
 * Phase 4 (Vector DB Selection) deliverable: the Architecture Decision Record
 * produced by the Recommendation Engine for one DiscoveryAssessment, once
 * Phases 1-3 are complete. Immutable once created - a changed assessment (or
 * a re-run) produces a new ADR, never an edit, so recommendations stay
 * reproducible from (assessment inputs, rulesVersion).
 */
@Entity({ name: 'architecture_decision_records' })
export class ArchitectureDecisionRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  // Many-to-one: re-running the selection on an unchanged assessment adds a record
  // (the history of runs is kept); it was one-to-one, which made every re-run fail.
  @ManyToOne(() => DiscoveryAssessment, { onDelete: 'CASCADE' })
  assessment: DiscoveryAssessment;

  @Column()
  rulesVersion: string;

  @Column({ type: 'enum', enum: VectorPlatform })
  decision: VectorPlatform;

  @Column('text')
  rationale: string;

  @Column({ type: 'jsonb' })
  options: ScoredOption[];

  @Column({ type: 'jsonb' })
  rejectedAlternatives: RankedAlternative[];

  /** Structured Assumption Register (spec S24) - every entry shows its source/type/confidence, not just a description. */
  @Column({ type: 'jsonb' })
  assumptions: AssumptionEntry[];

  /** Structured Risk Register (spec S23) - every entry has a category, impact, likelihood, mitigation, and status. */
  @Column({ type: 'jsonb' })
  risks: RiskEntry[];

  @Column({ type: 'jsonb' })
  infrastructureEstimate: InfrastructureEstimate;

  @Column()
  operationalComplexity: string;

  // Nullable: ADRs created before this field existed have no value for it.
  @Column({ type: 'jsonb', nullable: true })
  plainLanguageSummary: PlainLanguageSummary | null;

  @Column({ type: 'jsonb', nullable: true })
  criteriaWeights: CriteriaScores | null;

  @Column({ type: 'enum', enum: ['single', 'tied', 'conditional'], default: 'single' })
  decisionStatus: DecisionStatus;

  @Column({ type: 'enum', enum: ['high', 'medium', 'low'], default: 'high' })
  confidence: ConfidenceLevel;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  tiedPlatformIds: VectorPlatform[];

  @Column({ type: 'text', nullable: true })
  tieBreakStage: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  openValidations: string[];

  @Column({ type: 'jsonb', nullable: true })
  budgetFeasibility: BudgetFeasibility | null;

  @Column({ type: 'jsonb', nullable: true })
  complianceGate: ComplianceGateResult | null;

  /** Retrieval Strategy Assessment ("is a vector database needed at all?"); null when Discovery had no query mix. */
  @Column({ type: 'jsonb', nullable: true })
  retrievalStrategy: RetrievalStrategyResult | null;

  @CreateDateColumn()
  createdAt: Date;
}
