import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { DiscoveryAssessment } from './discovery-assessment.entity';
import { VectorPlatform } from '../projects/enums/platform.enum';
import {
  BudgetFeasibility,
  ComplianceGateResult,
  ConfidenceLevel,
  CriteriaScores,
  DecisionStatus,
  InfrastructureEstimate,
  PlainLanguageSummary,
  RankedAlternative,
  ScoredOption,
} from '../recommendation-engine/recommendation.types';

/**
 * Phase 1 deliverable: the Architecture Decision Record produced by the
 * Recommendation Engine for one DiscoveryAssessment. Immutable once created -
 * a changed assessment produces a new assessment + a new ADR, never an edit,
 * so recommendations stay reproducible from (assessment inputs, rulesVersion).
 */
@Entity({ name: 'architecture_decision_records' })
export class ArchitectureDecisionRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @OneToOne(() => DiscoveryAssessment, { onDelete: 'CASCADE' })
  @JoinColumn()
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

  @Column({ type: 'jsonb' })
  assumptions: string[];

  @Column({ type: 'jsonb' })
  risks: string[];

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

  @CreateDateColumn()
  createdAt: Date;
}
