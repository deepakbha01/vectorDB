/**
 * Mirrors the phase status lifecycle: NOT STARTED -> IN PROGRESS -> COMPLETED -> VALIDATED
 */
export enum PhaseStatus {
  NOT_STARTED = 'not_started',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  VALIDATED = 'validated',
}

export enum ProjectPhase {
  DISCOVERY = 'discovery',
  DATA_EMBEDDINGS = 'data_embeddings',
  INDEX_DESIGN = 'index_design',
  INFRASTRUCTURE = 'infrastructure',
  INGESTION = 'ingestion',
  OPTIMIZATION = 'optimization',
  CAPACITY = 'capacity',
}
