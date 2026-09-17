import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { IndexType } from '../index-recommendation-engine/enums/index-type.enum';
import { TuningParameter } from '../index-recommendation-engine/index-recommendation.types';
import { CapacityImpact, CostImplications, VariantResult } from './benchmark.types';

/**
 * Phase 6 deliverable: the Optimization Report. Compares search-time
 * parameter variants (efSearch/nprobe) against a synthetic corpus at the
 * project's embedding dimension, built on top of the real Phase 4 adapters
 * and the exact index configuration Phase 3 recommended.
 */
@Entity({ name: 'optimization_reports' })
export class OptimizationReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  version: number;

  @Column({ type: 'enum', enum: IndexType })
  indexType: IndexType;

  @Column({ type: 'jsonb' })
  baselineConfiguration: TuningParameter[];

  @Column()
  sampleSize: number;

  @Column()
  queryCount: number;

  @Column()
  topK: number;

  @Column({ type: 'jsonb' })
  variantResults: VariantResult[];

  @Column({ type: 'jsonb' })
  recommendedVariant: VariantResult;

  @Column({ type: 'jsonb' })
  bottlenecks: string[];

  @Column({ type: 'jsonb' })
  beforeAfterComparison: { baseline: VariantResult; recommended: VariantResult };

  @Column({ type: 'jsonb' })
  capacityImpact: CapacityImpact;

  @Column({ type: 'jsonb' })
  costImplications: CostImplications;

  @CreateDateColumn()
  createdAt: Date;
}
