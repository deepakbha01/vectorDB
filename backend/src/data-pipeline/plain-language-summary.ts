import { FitRating, PlainLanguageScorecardRow } from '../common/plain-language.types';
import { ChunkingStrategy } from '../chunking/enums/chunking-strategy.enum';

/**
 * Executive-summary translation of a Data Pipeline Design. Unlike Phase 1,
 * there is no competing-platform score here - this is a direct restatement of
 * the chosen configuration in business language, not a decision between
 * alternatives, so there is no "verdict" field.
 */
export interface DataPipelineExecutiveSummary {
  headline: string;
  scorecard: PlainLanguageScorecardRow[];
  costAndEffort: string;
  considerations: string[];
  bottomLine: string;
}

const STRATEGY_LABELS: Record<ChunkingStrategy, string> = {
  [ChunkingStrategy.FIXED_SIZE]: 'fixed-size',
  [ChunkingStrategy.TOKEN_BASED]: 'token-based',
  [ChunkingStrategy.SENTENCE_BASED]: 'sentence-based',
  [ChunkingStrategy.PARAGRAPH_BASED]: 'paragraph-based',
  [ChunkingStrategy.RECURSIVE]: 'recursive',
  [ChunkingStrategy.SEMANTIC]: 'semantic (heuristic)',
  [ChunkingStrategy.SLIDING_WINDOW]: 'sliding-window',
};

const CHUNK_UNIT_STRATEGIES = new Set<ChunkingStrategy>([ChunkingStrategy.TOKEN_BASED]);

/** Presentation-only bucketing - does not change the generated pipeline design, only how it is described. */
const SMALL_CHUNK_CEILING = 300;
const LARGE_CHUNK_FLOOR = 1200;
const LOW_OVERLAP_RATIO = 0.05;
const HIGH_OVERLAP_RATIO = 0.25;
const COST_GREAT_CEILING = 0.05;
const COST_OK_CEILING = 0.15;

export interface DataPipelineSummaryInput {
  chunkingStrategy: ChunkingStrategy;
  chunkSize: number;
  chunkOverlap: number;
  embeddingProviderId: string;
  embeddingModelId: string;
  embeddingDimension: number;
  costPerMillionTokens: number;
  qualityTier: string;
  metadataFieldCount: number;
  validationWarnings: string[];
}

function rateChunkSize(chunkSize: number): FitRating {
  if (chunkSize <= SMALL_CHUNK_CEILING) return 'ok'; // precise but limited context - a deliberate trade-off, not a defect
  if (chunkSize <= LARGE_CHUNK_FLOOR) return 'great';
  return 'ok'; // large chunks dilute relevance - workable, worth validating with a retrieval eval
}

function rateOverlap(ratio: number): FitRating {
  if (ratio < LOW_OVERLAP_RATIO) return 'ok';
  if (ratio <= HIGH_OVERLAP_RATIO) return 'great';
  return 'ok';
}

function rateQuality(qualityTier: string): FitRating {
  if (qualityTier === 'highest' || qualityTier === 'high') return 'great';
  if (qualityTier === 'medium') return 'ok';
  return 'weak';
}

function rateCost(costPerMillionTokens: number): FitRating {
  if (costPerMillionTokens <= COST_GREAT_CEILING) return 'great';
  if (costPerMillionTokens <= COST_OK_CEILING) return 'ok';
  return 'weak';
}

export function buildDataPipelineExecutiveSummary(input: DataPipelineSummaryInput): DataPipelineExecutiveSummary {
  const unit = CHUNK_UNIT_STRATEGIES.has(input.chunkingStrategy) ? 'words' : 'characters';
  const overlapRatio = input.chunkSize > 0 ? input.chunkOverlap / input.chunkSize : 0;
  const strategyLabel = STRATEGY_LABELS[input.chunkingStrategy] ?? input.chunkingStrategy;

  const chunkSizeRating = rateChunkSize(input.chunkSize);
  const overlapRating = rateOverlap(overlapRatio);
  const qualityRating = rateQuality(input.qualityTier);
  const costRating = rateCost(input.costPerMillionTokens);
  const validationRating: FitRating = input.validationWarnings.length === 0 ? 'great' : 'weak';

  const scorecard: PlainLanguageScorecardRow[] = [
    {
      label: 'Chunking Granularity',
      rating: chunkSizeRating,
      explanation:
        chunkSizeRating === 'great'
          ? `A ${input.chunkSize}-${unit} chunk size balances retrieval precision against context per chunk.`
          : input.chunkSize <= SMALL_CHUNK_CEILING
            ? `A ${input.chunkSize}-${unit} chunk size favors precise retrieval, at the cost of less context per chunk.`
            : `A ${input.chunkSize}-${unit} chunk size favors context per chunk, at the cost of retrieval precision.`,
    },
    {
      label: 'Context Continuity',
      rating: overlapRating,
      explanation:
        overlapRating === 'great'
          ? `An overlap of ${input.chunkOverlap} ${unit} (${(overlapRatio * 100).toFixed(0)}% of chunk size) preserves context across chunk boundaries.`
          : overlapRatio < LOW_OVERLAP_RATIO
            ? `An overlap of ${input.chunkOverlap} ${unit} (${(overlapRatio * 100).toFixed(0)}% of chunk size) risks losing context at chunk boundaries.`
            : `An overlap of ${input.chunkOverlap} ${unit} (${(overlapRatio * 100).toFixed(0)}% of chunk size) is generous and will increase storage and embedding cost.`,
    },
    {
      label: 'Embedding Quality',
      rating: qualityRating,
      explanation: `The selected model is rated '${input.qualityTier}' quality, producing ${input.embeddingDimension}-dimension vectors.`,
    },
    {
      label: 'Cost Efficiency',
      rating: costRating,
      explanation:
        input.costPerMillionTokens === 0
          ? 'Self-hosted model with no per-token embedding cost.'
          : `Approximately $${input.costPerMillionTokens} per million tokens embedded.`,
    },
    {
      label: 'Configuration Validity',
      rating: validationRating,
      explanation:
        validationRating === 'great'
          ? 'No configuration issues were identified.'
          : `${input.validationWarnings.length} configuration warning(s) require review before proceeding.`,
    },
  ];

  const headline =
    `Documents will be split using a ${strategyLabel} chunking strategy (up to ${input.chunkSize} ${unit} per chunk, ` +
    `with ${input.chunkOverlap} ${unit} of overlap to preserve context across chunk boundaries), then embedded using ` +
    `${input.embeddingProviderId}'s ${input.embeddingModelId} model into ${input.embeddingDimension}-dimension vectors.`;

  const costAndEffort =
    input.costPerMillionTokens === 0
      ? 'This configuration uses a self-hosted embedding model, avoiding per-token embedding costs.'
      : `Embedding costs are estimated at $${input.costPerMillionTokens} per million tokens processed. ` +
        `${input.metadataFieldCount} metadata field(s) will be stored alongside each vector for filtering.`;

  const considerations =
    input.validationWarnings.length > 0
      ? input.validationWarnings
      : ['No configuration issues were identified. Standard schema validation still applies at ingestion time.'];

  const bottomLine =
    input.validationWarnings.length > 0
      ? 'We recommend resolving the warnings above before proceeding to Phase 3 (Index Design).'
      : 'This data pipeline design is ready; you may proceed to Phase 3 (Index Design).';

  return { headline, scorecard, costAndEffort, considerations, bottomLine };
}
