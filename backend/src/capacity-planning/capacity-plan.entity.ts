import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { IndexType } from '../index-recommendation-engine/enums/index-type.enum';
import { CapacityForecastInput, HorizonForecast, ResourceEstimate, ShardingRecommendation } from './capacity-forecast.types';

/**
 * Phase 7 deliverable: the Capacity Plan. Versioned/persisted like the other
 * phase deliverables - a changed input produces a new row, not an edit.
 */
@Entity({ name: 'capacity_plans' })
export class CapacityPlan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  version: number;

  @Column({ type: 'enum', enum: VectorPlatform })
  platform: VectorPlatform;

  @Column({ type: 'enum', enum: IndexType })
  indexType: IndexType;

  @Column({ type: 'jsonb' })
  inputsUsed: CapacityForecastInput;

  @Column({ type: 'jsonb' })
  currentState: ResourceEstimate;

  @Column({ type: 'jsonb' })
  forecast: HorizonForecast[];

  @Column({ type: 'jsonb' })
  shardingRecommendation: ShardingRecommendation;

  @Column({ type: 'jsonb' })
  haRecommendation: string[];

  @Column({ type: 'jsonb' })
  drRecommendation: string[];

  @Column({ type: 'jsonb' })
  recommendedInfrastructure: string[];

  @CreateDateColumn()
  createdAt: Date;
}
