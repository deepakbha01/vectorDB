import { Injectable } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { VectorDbSelectionService } from '../vector-db-selection/vector-db-selection.service';
import { PhaseStatus } from '../projects/enums/project-status.enum';
import { CustomerMode } from '../projects/enums/customer-mode.enum';
import { AuthenticatedUser } from '../auth/auth.service';

/**
 * Aggregates the widgets shown on the main dashboard. Discovery-derived fields
 * (vector count, dataset size, target QPS/latency/recall, risks) populate as
 * soon as Phase 1 completes. Fields that depend on a *running* deployment
 * (measured P95 latency, measured recall, capacity utilization) stay null
 * until the Operations engines (Sprint 6/7) exist - the shape is fixed now so
 * the frontend does not need to change as those engines land.
 */
export interface ProjectDashboardSummary {
  projectId: string;
  projectName: string;
  customerMode: CustomerMode;
  assessmentStatus: PhaseStatus;
  recommendedPlatform: string;
  platformIsManualOverride: boolean;
  vectorCount: number | null;
  datasetSizeBytes: number | null;
  targetQps: number | null;
  targetP95LatencyMs: number | null;
  measuredP95LatencyMs: number | null;
  targetRecallAtK: number | null;
  measuredRecallAtK: number | null;
  capacityUtilizationPercent: number | null;
  risks: string[];
  recommendations: string[];
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly discoveryService: DiscoveryService,
    private readonly vectorDbSelectionService: VectorDbSelectionService,
  ) {}

  async getSummary(userId: string): Promise<ProjectDashboardSummary[]> {
    const projects = await this.projectsService.findAllForUser(userId);

    return Promise.all(
      projects.map(async (project) => {
        // findAllForUser already scoped to this owner, so they always pass the access check.
        const requester: AuthenticatedUser = { id: userId, email: project.owner.email, role: project.owner.role };
        const outcome = await this.discoveryService.getLatest(project.id, requester);
        const vectorDbSelection = await this.vectorDbSelectionService.getLatest(project.id, requester);

        let recommendations: string[] = [];
        if (project.phaseStatuses.discovery !== PhaseStatus.COMPLETED) {
          recommendations = ['Complete the Phase 1 Discovery assessment.'];
        } else if (project.platform === 'undetermined') {
          recommendations = ['Run Phase 4 Vector DB Selection to receive a platform recommendation.'];
        }

        return {
          projectId: project.id,
          projectName: project.name,
          customerMode: project.customerMode,
          assessmentStatus: project.phaseStatuses.discovery,
          recommendedPlatform: project.platform,
          platformIsManualOverride: project.platformIsManualOverride,
          vectorCount: outcome?.assessment.estimatedVectorCount ?? null,
          datasetSizeBytes: outcome
            ? Math.round(outcome.assessment.documentCount * outcome.assessment.avgDocumentSizeKb * 1024)
            : null,
          targetQps: outcome?.assessment.qps ?? null,
          targetP95LatencyMs: outcome?.assessment.targetP95LatencyMs ?? null,
          measuredP95LatencyMs: null,
          targetRecallAtK: outcome?.assessment.recallTarget ?? null,
          measuredRecallAtK: null,
          capacityUtilizationPercent: null,
          risks: vectorDbSelection?.adr.risks.map((r) => r.description) ?? [],
          recommendations,
        };
      }),
    );
  }
}
