import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectsService } from '../../projects/projects.service';
import { Project } from '../../projects/project.entity';
import { User } from '../../users/user.entity';
import { AuthenticatedUser } from '../../auth/auth.service';
import { DiscoveryAssessment } from '../../discovery/discovery-assessment.entity';
import { DataPipelineDesign } from '../../data-pipeline/data-pipeline-design.entity';
import { ArchitectureDecisionRecord } from '../../vector-db-selection/architecture-decision-record.entity';
import { PlatformConfigService } from '../../common/config/platform-config.service';
import { FULLY_MANAGED_SAAS_PLATFORMS, VectorPlatform } from '../../projects/enums/platform.enum';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { AiWorkloadProfile } from '../workload-profile/workload-profile.entity';
import { AiModelSelection } from '../model-selection/model-selection.entity';
import { ModelCatalogue } from '../model-selection/model-selection.types';
import { AiInferenceArchitecture } from '../inference-architecture/inference-architecture.entity';
import { AiInfrastructureDesign } from '../infrastructure/infrastructure.entity';
import { AiRagAgentDesign } from '../rag-agent/rag-agent.entity';
import { AiSecurityAssessment } from './security.entity';
import { assessSecurity } from './security.engine';
import { CreateSecurityAssessmentDto } from './create-security-assessment.dto';
import { ComponentFacts, DesignStatement, SecurityContext, SecurityResult } from './security.types';

export type SecuritySource = { source: 'user' | 'workload_profile' | 'discovery' | 'default' | 'upstream'; detail: string };

export interface SecurityInputs {
  project: Pick<Project, 'platform'>;
  profile: AiWorkloadProfile | null;
  discovery: DiscoveryAssessment | null;
  pipeline: DataPipelineDesign | null;
  adr: ArchitectureDecisionRecord | null;
  selection: AiModelSelection | null;
  architecture: AiInferenceArchitecture | null;
  infrastructure: AiInfrastructureDesign | null;
  ragAgent: AiRagAgentDesign | null;
}

export interface SecurityCatalogues {
  models: ModelCatalogue;
  managedServingIds: string[];
  externalRerankIds: string[];
  embeddingRegion: (providerId: string, modelId: string) => string | null;
}

/** Pure: builds the assessment context - the components of the chosen architecture and every security statement the designs made. */
export function resolveSecurityContext(dto: CreateSecurityAssessmentDto, x: SecurityInputs, c: SecurityCatalogues) {
  if (!x.profile && !x.discovery) throw new BadRequestException('Nothing to assess yet - complete Discovery or the AI Workload Profile first.');
  const sources: Record<string, SecuritySource> = {};
  const pv = x.profile ? `Workload Profile v${x.profile.version}` : '';
  const d = x.discovery;
  const profileValue = <T>(k: string): T | null => ((x.profile?.inputs as any)?.[k]?.value ?? null) as T | null;

  const classification = x.profile?.result.dataClassification.level ?? (d?.containsPii ? 'confidential' : 'internal');
  sources.classification = x.profile ? { source: 'workload_profile', detail: `${pv}: ${classification} (${x.profile.result.dataClassification.reasons.join('; ') || 'no sensitive data'})` } : { source: 'discovery', detail: `Discovery v${d!.version}: ${d!.containsPii ? 'PII' : 'no PII'}` };
  const targets = profileValue<string[]>('deploymentTargets') ?? [];
  const vendorDpaSigned = dto.vendorDpaSigned ?? false;
  const vendorBaaSigned = dto.vendorBaaSigned ?? false;
  sources.vendorDpaSigned = dto.vendorDpaSigned !== undefined ? { source: 'user', detail: 'set in the security inputs' } : { source: 'default', detail: 'not stated - assumed no DPA' };
  sources.vendorBaaSigned = dto.vendorBaaSigned !== undefined ? { source: 'user', detail: 'set in the security inputs' } : { source: 'default', detail: 'not stated - assumed no BAA' };

  // --------------------------------------------------------- components
  const components: ComponentFacts[] = [];
  if (x.adr) {
    const platform = x.project.platform && x.project.platform !== VectorPlatform.UNDETERMINED ? x.project.platform : x.adr.decision;
    const gate = x.adr.complianceGate;
    components.push({
      id: 'vector_database',
      kind: 'vector_database',
      label: 'Vector database',
      choice: platform,
      source: 'Vector DB decision',
      external: FULLY_MANAGED_SAAS_PLATFORMS.includes(platform as VectorPlatform),
      dataPath: 'document',
      region: null,
      complianceGate: gate ? { status: gate.status, missing: gate.checks.filter((k) => !k.satisfied).map((k) => k.control) } : null,
    });
  }
  if (x.pipeline) {
    const p = x.pipeline;
    components.push({
      id: 'embedding_model',
      kind: 'embedding_model',
      label: 'Embedding model',
      choice: `${p.embeddingModelId} (${p.embeddingProviderId})`,
      source: `Data Pipeline Design v${p.version}`,
      external: p.embeddingProviderId !== 'open_source',
      dataPath: 'document',
      region: c.embeddingRegion(p.embeddingProviderId, p.embeddingModelId),
    });
  }
  const managedServing = !!x.architecture?.result.recommended && c.managedServingIds.includes(x.architecture.result.recommended.id);
  let inBoundaryModel = false;
  if (x.selection) {
    const r = x.selection.result;
    const seen = new Set<string>();
    for (const [role, m] of [['Primary', r.primary], ['Secondary', r.secondary], ['Fallback', r.fallback]] as const) {
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      const cm = c.models.models.find((k) => k.id === m.id);
      const terms = cm ? c.models.licences[cm.licence] : undefined;
      const external = m.family === 'proprietary_api' || managedServing;
      if (!external) inBoundaryModel = true;
      components.push({
        id: `model:${m.id}`,
        kind: 'model',
        label: `${role} model`,
        choice: m.label,
        source: `Model Selection v${x.selection.version}`,
        external,
        dataPath: 'request',
        region: null,
        licence: cm && terms ? { id: cm.licence, label: terms.label, permissive: terms.permissive } : null,
      });
    }
  }
  if (x.architecture?.result.recommended) {
    components.push({
      id: 'serving_runtime',
      kind: 'serving_runtime',
      label: 'Serving runtime',
      choice: x.architecture.result.recommended.label,
      source: `Inference Architecture v${x.architecture.version}`,
      external: managedServing,
      dataPath: managedServing ? 'request' : 'none',
      region: null,
    });
  }
  const rag = x.ragAgent?.result;
  const rerank = rag?.decisions.find((k) => k.area === 'reranking')?.chosen;
  if (rerank && rerank.id !== 'none') {
    const external = c.externalRerankIds.includes(rerank.id);
    components.push({ id: 'reranker', kind: 'reranker', label: 'Reranker', choice: rerank.label, source: `RAG / Agent Architecture v${x.ragAgent!.version}`, external, dataPath: external ? 'request' : 'none', region: null });
  }
  if (rag?.scope.agent && x.ragAgent) {
    components.push({ id: 'agent_tools', kind: 'agent_tools', label: 'Agent tools', choice: x.ragAgent.context.toolAccess.replace(/_/g, ' '), source: `RAG / Agent Architecture v${x.ragAgent.version}`, external: false, dataPath: 'none', toolAccess: x.ragAgent.context.toolAccess });
  }
  for (const pl of x.infrastructure?.result.placements ?? []) {
    if (!pl.chosen) continue;
    components.push({
      id: `deployment:${pl.component}`,
      kind: 'deployment',
      label: `Deployment - ${pl.componentLabel.toLowerCase()}`,
      choice: pl.chosen.label,
      source: `Infrastructure Design v${x.infrastructure!.version}`,
      external: false,
      dataPath: 'none',
      placement: { eligibility: pl.chosen.eligibility, conditions: pl.chosen.conditions },
    });
  }

  // --------------------------------------------------------- statements
  const statements: DesignStatement[] = [];
  const add = (source: string, lines: string[] | undefined) => (lines ?? []).forEach((text) => statements.push({ source, text }));
  const arch = x.architecture?.result.architecture;
  if (arch) {
    const s = `Inference Architecture v${x.architecture!.version}`;
    add(`${s} · gateway`, arch.gateway);
    add(`${s} · policy engine`, arch.policy);
    add(`${s} · security`, arch.security);
    add(`${s} · observability`, arch.observability);
  }
  if (x.infrastructure) {
    const s = `Infrastructure Design v${x.infrastructure.version}`;
    add(`${s} · security`, x.infrastructure.result.sections.security);
    add(`${s} · network`, x.infrastructure.result.sections.network);
  }
  if (rag) {
    const s = `RAG / Agent Architecture v${x.ragAgent!.version}`;
    for (const [k, lines] of Object.entries(rag.rag ?? {})) add(`${s} · ${k}`, lines);
    for (const [k, lines] of Object.entries(rag.agent ?? {})) add(`${s} · ${k}`, lines);
  }
  if (x.selection) {
    const models = components.filter((k) => k.kind === 'model');
    add(`Model Selection v${x.selection.version}`, [`Model licences recorded: ${models.map((m) => `${m.choice} - ${m.licence?.label ?? 'unknown'}`).join('; ')}`]);
  }

  const missingDesigns = [
    !x.selection && 'Model Selection',
    !x.architecture && 'Inference Architecture',
    !x.infrastructure && 'Infrastructure Design',
    !x.ragAgent && 'RAG / Agent Architecture',
  ].filter((k): k is string => !!k);

  const context: SecurityContext = {
    classification,
    containsPii: !!(d?.containsPii || profileValue<boolean>('containsPii')),
    containsPhi: !!profileValue<boolean>('containsPhi'),
    containsPci: !!profileValue<boolean>('containsPci'),
    dataResidency: profileValue<string>('dataResidencyRequirement') ?? d?.dataResidencyRequirement ?? null,
    regulatory: profileValue<string>('regulatoryRequirements') ?? d?.regulatoryRequirements ?? null,
    onPremOnly: targets.length === 1 && targets[0] === 'on_premises',
    requiresAuthentication: d?.requiresAuthentication ?? false,
    requiresRbac: d?.requiresRbac ?? false,
    requiresEncryptionAtRest: !!(d?.requiresEncryptionAtRest || profileValue<boolean>('requiresEncryptionAtRest')),
    requiresEncryptionInTransit: !!(d?.requiresEncryptionInTransit || profileValue<boolean>('requiresEncryptionInTransit')),
    requiresKeyManagement: d?.requiresKeyManagement ?? false,
    requiresTenantIsolation: d?.requiresTenantIsolation ?? false,
    requiresAuditLogging: d?.requiresAuditLogging ?? false,
    retentionDays: d?.retentionDays || null,
    genAi: !!(x.selection || x.architecture || x.ragAgent),
    cloudPlacement: (x.infrastructure?.result.placements ?? []).some((p) => p.chosen && p.chosen.target !== 'on_premises'),
    policyEngine: !!arch,
    inBoundaryModel,
    vendorDpaSigned,
    vendorBaaSigned,
    components,
    statements,
    missingDesigns,
  };
  if (d) sources.requirements = { source: 'discovery', detail: `Discovery v${d.version}: security requirements` };
  if (x.profile) sources.dataFlags = { source: 'workload_profile', detail: `${pv}: PII / PHI / PCI, residency, deployment targets` };
  sources.components = { source: 'upstream', detail: `${components.length} component(s) from the latest design records` };
  return { context, sources };
}

@Injectable()
export class SecurityAssessmentService {
  private readonly logger = new Logger(SecurityAssessmentService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly cfg: AiFactoryConfigService,
    private readonly platformConfig: PlatformConfigService,
    @InjectRepository(AiSecurityAssessment) private readonly assessments: Repository<AiSecurityAssessment>,
    @InjectRepository(AiWorkloadProfile) private readonly profiles: Repository<AiWorkloadProfile>,
    @InjectRepository(DiscoveryAssessment) private readonly discovery: Repository<DiscoveryAssessment>,
    @InjectRepository(DataPipelineDesign) private readonly pipelines: Repository<DataPipelineDesign>,
    @InjectRepository(ArchitectureDecisionRecord) private readonly adrs: Repository<ArchitectureDecisionRecord>,
    @InjectRepository(AiModelSelection) private readonly selections: Repository<AiModelSelection>,
    @InjectRepository(AiInferenceArchitecture) private readonly architectures: Repository<AiInferenceArchitecture>,
    @InjectRepository(AiInfrastructureDesign) private readonly infrastructure: Repository<AiInfrastructureDesign>,
    @InjectRepository(AiRagAgentDesign) private readonly ragAgent: Repository<AiRagAgentDesign>,
  ) {}

  private catalogues(): SecurityCatalogues {
    const providers = this.platformConfig.getEmbeddingProviders();
    return {
      models: this.cfg.getModelCatalogue(),
      managedServingIds: this.cfg.getServingCatalogue().servingOptions.filter((o) => o.gpuVendors.includes('provider')).map((o) => o.id),
      externalRerankIds: this.cfg.getRagAgentCatalogue().reranking.options.filter((o) => o.external).map((o) => o.id),
      embeddingRegion: (providerId, modelId) => providers.find((p) => p.id === providerId)?.models?.find((m: any) => m.id === modelId)?.region ?? null,
    };
  }

  private async resolve(projectId: string, requester: AuthenticatedUser, dto: CreateSecurityAssessmentDto) {
    const project = await this.projectsService.findOne(projectId, requester);
    const where = { project: { id: projectId } };
    const order = { createdAt: 'DESC' as const };
    const [profile, discovery, pipeline, adr, selection, architecture, infrastructure, ragAgent] = await Promise.all([
      this.profiles.findOne({ where, order }),
      this.discovery.findOne({ where, order }),
      this.pipelines.findOne({ where, order }),
      this.adrs.findOne({ where, order }),
      this.selections.findOne({ where, order }),
      this.architectures.findOne({ where, order }),
      this.infrastructure.findOne({ where, order }),
      this.ragAgent.findOne({ where, order }),
    ]);
    return resolveSecurityContext(dto, { project, profile, discovery, pipeline, adr, selection, architecture, infrastructure, ragAgent }, this.catalogues());
  }

  async getDefaults(projectId: string, requester: AuthenticatedUser): Promise<{ context: SecurityContext; sources: Record<string, SecuritySource>; preview: SecurityResult }> {
    const resolved = await this.resolve(projectId, requester, {});
    return { ...resolved, preview: assessSecurity(resolved.context, this.cfg.getSecurityCatalogue()) };
  }

  async submit(projectId: string, requester: AuthenticatedUser, dto: CreateSecurityAssessmentDto): Promise<AiSecurityAssessment> {
    const { context, sources } = await this.resolve(projectId, requester, dto);
    const result = assessSecurity(context, this.cfg.getSecurityCatalogue());
    const version = (await this.assessments.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.assessments.save(
      this.assessments.create({ project: { id: projectId } as Project, createdBy: { id: requester.id } as User, version, submitted: dto, context, sources, result, rulesVersion: result.rulesVersion }),
    );
    this.logger.log(`user=${requester.email} action=assess_security projectId=${projectId} version=${version} overall=${result.overall.status} validation=${result.validation.status} gaps=${result.gaps.length}`);
    return saved;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<AiSecurityAssessment | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.assessments.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
