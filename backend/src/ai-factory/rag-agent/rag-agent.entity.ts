import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { RagAgentContext, RagAgentResult } from './rag-agent.types';
import { CreateRagAgentDesignDto } from './create-rag-agent-design.dto';

/** GenAI Application Architecture - RAG / agent design (spec §10), versioned per project. */
@Entity({ name: 'ai_rag_agent_designs' })
export class AiRagAgentDesign {
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
  submitted: CreateRagAgentDesignDto;

  @Column({ type: 'jsonb' })
  context: RagAgentContext;

  @Column({ type: 'jsonb' })
  sources: Record<string, { source: string; detail: string }>;

  @Column({ type: 'jsonb' })
  result: RagAgentResult;

  @Column()
  rulesVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
