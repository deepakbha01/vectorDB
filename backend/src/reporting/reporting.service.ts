import { Injectable, NotFoundException } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { DataPipelineDesignService } from '../data-pipeline/data-pipeline-design.service';
import { IndexDesignService } from '../index-design/index-design.service';
import { DeploymentPlanService } from '../deployment/deployment-plan.service';
import { BenchmarkService } from '../benchmark/benchmark.service';
import { CapacityPlanningService } from '../capacity-planning/capacity-planning.service';
import { ReportBuilderService } from './report-builder.service';
import { PdfRendererService } from './pdf-renderer.service';
import { DocxRendererService } from './docx-renderer.service';
import { AuthenticatedUser } from '../auth/auth.service';

export const REPORT_TYPES = ['discovery', 'data-pipeline', 'index-design', 'deployment-plan', 'optimization-report', 'capacity-plan', 'complete'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const REPORT_FORMATS = ['pdf', 'docx'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface RenderedReport {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

const CONTENT_TYPES: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

@Injectable()
export class ReportingService {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly discoveryService: DiscoveryService,
    private readonly dataPipelineDesignService: DataPipelineDesignService,
    private readonly indexDesignService: IndexDesignService,
    private readonly deploymentPlanService: DeploymentPlanService,
    private readonly benchmarkService: BenchmarkService,
    private readonly capacityPlanningService: CapacityPlanningService,
    private readonly reportBuilder: ReportBuilderService,
    private readonly pdfRenderer: PdfRendererService,
    private readonly docxRenderer: DocxRendererService,
  ) {}

  async generateReport(projectId: string, requester: AuthenticatedUser, type: ReportType, format: ReportFormat): Promise<RenderedReport> {
    const project = await this.projectsService.findOne(projectId, requester);
    const doc = await this.buildDocument(project.id, requester, type, project);

    const buffer = format === 'pdf' ? await this.pdfRenderer.render(doc) : await this.docxRenderer.render(doc);
    return {
      buffer,
      filename: `${slugify(doc.title)}.${format}`,
      contentType: CONTENT_TYPES[format],
    };
  }

  private async buildDocument(projectId: string, requester: AuthenticatedUser, type: ReportType, project: Awaited<ReturnType<ProjectsService['findOne']>>) {
    if (type === 'discovery') {
      const outcome = await this.discoveryService.getLatest(projectId, requester);
      if (!outcome) throw new NotFoundException('No Discovery assessment has been submitted for this project yet.');
      return this.reportBuilder.buildDiscoveryReport(outcome.assessment, outcome.adr);
    }
    if (type === 'data-pipeline') {
      const design = await this.dataPipelineDesignService.getLatest(projectId, requester);
      if (!design) throw new NotFoundException('No Data Pipeline Design has been submitted for this project yet.');
      return this.reportBuilder.buildDataPipelineReport(design);
    }
    if (type === 'index-design') {
      const design = await this.indexDesignService.getLatest(projectId, requester);
      if (!design) throw new NotFoundException('No Index Design has been submitted for this project yet.');
      return this.reportBuilder.buildIndexDesignReport(design);
    }
    if (type === 'deployment-plan') {
      const plan = await this.deploymentPlanService.getLatest(projectId, requester);
      if (!plan) throw new NotFoundException('No Deployment Plan has been submitted for this project yet.');
      return this.reportBuilder.buildDeploymentPlanReport(plan);
    }
    if (type === 'optimization-report') {
      const report = await this.benchmarkService.getLatest(projectId, requester);
      if (!report) throw new NotFoundException('No Optimization Report has been generated for this project yet.');
      return this.reportBuilder.buildOptimizationReport(report);
    }
    if (type === 'capacity-plan') {
      const plan = await this.capacityPlanningService.getLatest(projectId, requester);
      if (!plan) throw new NotFoundException('No Capacity Plan has been generated for this project yet.');
      return this.reportBuilder.buildCapacityPlanReport(plan);
    }

    // complete: assembles whichever phases are available - partial completion is expected and shown as such.
    const [discovery, dataPipeline, indexDesign, deploymentPlan, optimizationReport, capacityPlan] = await Promise.all([
      this.discoveryService.getLatest(projectId, requester),
      this.dataPipelineDesignService.getLatest(projectId, requester),
      this.indexDesignService.getLatest(projectId, requester),
      this.deploymentPlanService.getLatest(projectId, requester),
      this.benchmarkService.getLatest(projectId, requester),
      this.capacityPlanningService.getLatest(projectId, requester),
    ]);
    return this.reportBuilder.buildCompleteReport(project, {
      discovery: discovery ?? undefined,
      dataPipeline: dataPipeline ?? undefined,
      indexDesign: indexDesign ?? undefined,
      deploymentPlan: deploymentPlan ?? undefined,
      optimizationReport: optimizationReport ?? undefined,
      capacityPlan: capacityPlan ?? undefined,
    });
  }
}
