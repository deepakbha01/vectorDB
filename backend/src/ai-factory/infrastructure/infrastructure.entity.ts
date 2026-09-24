import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { InfraContext, InfrastructureResult } from './infrastructure.types';
import { CreateInfrastructureDesignDto } from './create-infrastructure-design.dto';

/** Infrastructure Decision Record (spec §9), versioned per project. */
@Entity({ name: 'ai_infrastructure_designs' })
export class AiInfrastructureDesign {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @Index()
  project: Project;

  @ManyToOne(() => User)
  createdBy: User;

  @Column()
  version: number;

  @Column({ type: 'jsonb' })
  submitted: CreateInfrastructureDesignDto;

  @Column({ type: 'jsonb' })
  context: InfraContext;

  @Column({ type: 'jsonb' })
  sources: Record<string, { source: string; detail: string }>;

  @Column({ type: 'jsonb' })
  result: InfrastructureResult;

  @Column()
  rulesVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
