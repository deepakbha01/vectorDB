import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ReportingService } from './reporting.service';
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

describe('ReportingService', () => {
  let service: ReportingService;
  let projectsService: { findOne: jest.Mock };
  let discoveryService: { getLatest: jest.Mock };
  let dataPipelineDesignService: { getLatest: jest.Mock };
  let indexDesignService: { getLatest: jest.Mock };
  let deploymentPlanService: { getLatest: jest.Mock };
  let benchmarkService: { getLatest: jest.Mock };
  let capacityPlanningService: { getLatest: jest.Mock };
  let reportBuilder: {
    buildDiscoveryReport: jest.Mock;
    buildDataPipelineReport: jest.Mock;
    buildIndexDesignReport: jest.Mock;
    buildDeploymentPlanReport: jest.Mock;
    buildOptimizationReport: jest.Mock;
    buildCapacityPlanReport: jest.Mock;
    buildCompleteReport: jest.Mock;
  };
  let pdfRenderer: { render: jest.Mock };
  let docxRenderer: { render: jest.Mock };

  const requester = { id: 'user-1', email: 'architect@example.com', role: 'architect' as any };
  const project = { id: 'project-1', name: 'RAG Assistant' };
  const doc = { title: 'Some Report', generatedAt: new Date().toISOString(), sections: [] };

  beforeEach(async () => {
    projectsService = { findOne: jest.fn().mockResolvedValue(project) };
    discoveryService = { getLatest: jest.fn() };
    dataPipelineDesignService = { getLatest: jest.fn() };
    indexDesignService = { getLatest: jest.fn() };
    deploymentPlanService = { getLatest: jest.fn() };
    benchmarkService = { getLatest: jest.fn() };
    capacityPlanningService = { getLatest: jest.fn() };
    reportBuilder = {
      buildDiscoveryReport: jest.fn().mockReturnValue(doc),
      buildDataPipelineReport: jest.fn().mockReturnValue(doc),
      buildIndexDesignReport: jest.fn().mockReturnValue(doc),
      buildDeploymentPlanReport: jest.fn().mockReturnValue(doc),
      buildOptimizationReport: jest.fn().mockReturnValue(doc),
      buildCapacityPlanReport: jest.fn().mockReturnValue(doc),
      buildCompleteReport: jest.fn().mockReturnValue(doc),
    };
    pdfRenderer = { render: jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')) };
    docxRenderer = { render: jest.fn().mockResolvedValue(Buffer.from('docx-bytes')) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportingService,
        { provide: ProjectsService, useValue: projectsService },
        { provide: DiscoveryService, useValue: discoveryService },
        { provide: DataPipelineDesignService, useValue: dataPipelineDesignService },
        { provide: IndexDesignService, useValue: indexDesignService },
        { provide: DeploymentPlanService, useValue: deploymentPlanService },
        { provide: BenchmarkService, useValue: benchmarkService },
        { provide: CapacityPlanningService, useValue: capacityPlanningService },
        { provide: ReportBuilderService, useValue: reportBuilder },
        { provide: PdfRendererService, useValue: pdfRenderer },
        { provide: DocxRendererService, useValue: docxRenderer },
      ],
    }).compile();

    service = module.get(ReportingService);
  });

  it('dispatches to the discovery builder and renders PDF by default format', async () => {
    discoveryService.getLatest.mockResolvedValue({ assessment: {}, adr: {} });
    const result = await service.generateReport('project-1', requester, 'discovery', 'pdf');

    expect(reportBuilder.buildDiscoveryReport).toHaveBeenCalled();
    expect(pdfRenderer.render).toHaveBeenCalledWith(doc);
    expect(result.filename).toBe('some-report.pdf');
    expect(result.contentType).toBe('application/pdf');
  });

  it('renders DOCX when requested', async () => {
    discoveryService.getLatest.mockResolvedValue({ assessment: {}, adr: {} });
    const result = await service.generateReport('project-1', requester, 'discovery', 'docx');
    expect(docxRenderer.render).toHaveBeenCalledWith(doc);
    expect(result.contentType).toContain('wordprocessingml');
  });

  it('throws NotFoundException when the requested deliverable does not exist yet', async () => {
    discoveryService.getLatest.mockResolvedValue(null);
    await expect(service.generateReport('project-1', requester, 'discovery', 'pdf')).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['data-pipeline', 'dataPipelineDesignService', 'buildDataPipelineReport'],
    ['index-design', 'indexDesignService', 'buildIndexDesignReport'],
    ['deployment-plan', 'deploymentPlanService', 'buildDeploymentPlanReport'],
    ['optimization-report', 'benchmarkService', 'buildOptimizationReport'],
    ['capacity-plan', 'capacityPlanningService', 'buildCapacityPlanReport'],
  ] as const)('dispatches report type "%s" to the right service and builder', async (type, serviceKey, builderKey) => {
    const services: Record<string, { getLatest: jest.Mock }> = {
      dataPipelineDesignService,
      indexDesignService,
      deploymentPlanService,
      benchmarkService,
      capacityPlanningService,
    };
    services[serviceKey].getLatest.mockResolvedValue({});

    await service.generateReport('project-1', requester, type as any, 'pdf');

    expect((reportBuilder as any)[builderKey]).toHaveBeenCalled();
  });

  it('assembles the complete report from whichever phases are available, without throwing on missing ones', async () => {
    discoveryService.getLatest.mockResolvedValue(null);
    dataPipelineDesignService.getLatest.mockResolvedValue({ id: 'dp-1' });
    indexDesignService.getLatest.mockResolvedValue(null);
    deploymentPlanService.getLatest.mockResolvedValue(null);
    benchmarkService.getLatest.mockResolvedValue(null);
    capacityPlanningService.getLatest.mockResolvedValue(null);

    await service.generateReport('project-1', requester, 'complete', 'pdf');

    expect(reportBuilder.buildCompleteReport).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ discovery: undefined, dataPipeline: { id: 'dp-1' } }),
    );
  });
});
