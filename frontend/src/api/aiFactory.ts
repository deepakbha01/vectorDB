/** AI Factory (Wave 1) API types - mirrors backend/src/ai-factory/ai-factory.types.ts. */
import { useEffect, useState } from 'react';
import { apiClient } from './client';

export type PhaseKey = 'discovery' | 'data_embeddings' | 'index_design' | 'vector_db_selection' | 'infrastructure' | 'optimization' | 'capacity' | 'inference' | 'workload_profile' | 'model_selection' | 'inference_architecture' | 'infrastructure_design' | 'rag_agent_architecture' | 'security_governance' | 'performance_benchmark' | 'finops' | 'operations_model';
export type LineageStatus = 'current' | 'stale' | 'review' | 'not_started';
export type StepStatus = LineageStatus | 'in_progress' | 'not_yet_available';
export type SectionStatus = LineageStatus | 'not_yet_available';
export type EvidenceType = 'estimated' | 'vendor_listed' | 'measured' | 'assumption';
export type Eligibility = 'eligible' | 'conditional' | 'not_eligible' | 'not_assessed';

export interface PhaseLineage {
  phase: PhaseKey;
  label: string;
  route: string;
  status: LineageStatus;
  latest: { id: string; version: number; createdAt: string } | null;
  versions: number;
  upstream: Array<{ phase: PhaseKey; kind: 'hard' | 'advisory'; builtFromVersion: number | null; latestVersion: number | null; changedSinceBuilt: boolean }>;
  reasons: Array<{ type: string; phase: PhaseKey; message: string }>;
  changedDiscoveryFields?: string[];
}

export interface StepState {
  number: number;
  key: string;
  title: string;
  phases: PhaseKey[];
  coverage: 'full' | 'partial' | 'none';
  plannedWave?: number;
  note?: string;
  status: StepStatus;
  phaseStatuses: Array<{ phase: PhaseKey; label: string; route: string; status: LineageStatus }>;
}

export interface StateSection {
  status: SectionStatus;
  coverage: 'full' | 'partial' | 'none';
  source: { phase: PhaseKey; version: number; createdAt: string } | null;
  summary: Record<string, unknown>;
  plannedWave?: number;
}

export type AssessmentState = Record<
  'useCase' | 'scale' | 'data' | 'embedding' | 'vectorDB' | 'index' | 'model' | 'inference' | 'infrastructure' | 'rag' | 'security' | 'performance' | 'cost' | 'operations' | 'recommendation',
  StateSection
>;

export interface AiFactoryOverview {
  rulesVersion: string;
  steps: StepState[];
  phases: PhaseLineage[];
  state: AssessmentState;
}

export interface DecisionRecord {
  phase: PhaseKey;
  title: string;
  source: { deliverableId: string; version: number; createdAt: string };
  status: 'decided' | 'tied' | 'conditional' | 'not_feasible';
  recommendation: { id: string; label: string } | null;
  confidence: 'high' | 'medium' | 'low' | 'not_assessed';
  why: string[];
  candidates: Array<{ id: string; label: string; eligibility: Eligibility; score: number | null; notes: string[] }>;
  alternatives: Array<{ id: string; label: string; eligibility: Eligibility; reason: string }>;
  tradeoffs: string[];
  risks: string[];
  assumptions: Array<{ statement: string; evidenceType: EvidenceType }>;
  evidence: Array<{ label: string; value: string; evidenceType: EvidenceType }>;
  benchmarkRequired: string[];
  wouldChangeIf: string[];
  gaps: string[];
}

export interface ImpactAnalysis {
  fromVersion: number;
  toVersion: number;
  changes: Array<{ field: string; from: unknown; to: unknown; directPhases: PhaseKey[] }>;
  affected: Array<{ phase: PhaseKey; label: string; action: 'rerun' | 'review'; because: string[] }>;
  unaffected: Array<{ phase: PhaseKey; label: string; reason: string }>;
  noImpactFields: string[];
}

export interface SnapshotSummary {
  id: string;
  version: number;
  label: string | null;
  rulesVersion: string;
  createdAt: string;
}

export interface SnapshotComparison {
  from: number;
  to: number;
  sections: Array<{ section: string; change: 'unchanged' | 'changed'; statusFrom: SectionStatus; statusTo: SectionStatus; changedFields: string[] }>;
}

/** Phase lineage for the sidebar's stale badges. Only fetched when the AI Factory flag is on. */
export function useLineage(projectId: string, enabled: boolean): Partial<Record<PhaseKey, LineageStatus>> {
  const [statuses, setStatuses] = useState<Partial<Record<PhaseKey, LineageStatus>>>({});
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    apiClient
      .get<AiFactoryOverview>(`/projects/${projectId}/ai-factory`)
      .then((res) => active && setStatuses(Object.fromEntries(res.data.phases.map((p) => [p.phase, p.status]))))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [projectId, enabled]);
  return statuses;
}
