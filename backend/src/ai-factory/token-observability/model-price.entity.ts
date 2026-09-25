import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Project } from '../../projects/project.entity';
import { numeric } from './numeric.transformer';

export type PriceTokenType = 'input' | 'output' | 'cached_input' | 'reasoning' | 'embedding' | 'reranking';

/**
 * Versioned token prices (spec §13). A price change never edits a row: the
 * open row is closed (effectiveTo) and a new one starts, so any past moment
 * can still be priced as it was. Usage events store the cost they were given
 * at ingest, so later price changes never rewrite history.
 *
 * project = null is the catalogue price; a project row is a contracted
 * override for that project only.
 */
@Entity({ name: 'ai_model_prices' })
@Index(['provider', 'model', 'tokenType', 'effectiveFrom'])
export class AiModelPrice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE', nullable: true })
  @Index()
  project: Project | null;

  @Column()
  provider: string;

  @Column()
  model: string;

  @Column({ type: 'varchar', length: 32 })
  tokenType: PriceTokenType;

  @Column({ type: 'numeric', precision: 18, scale: 8, transformer: numeric })
  pricePer1M: number;

  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency: string;

  @Column({ type: 'timestamptz' })
  effectiveFrom: Date;

  @Column({ type: 'timestamptz', nullable: true })
  effectiveTo: Date | null;

  /** Where the figure came from, e.g. "inference.yaml managedApiTiers (list price)". */
  @Column()
  source: string;

  @CreateDateColumn()
  createdAt: Date;
}
