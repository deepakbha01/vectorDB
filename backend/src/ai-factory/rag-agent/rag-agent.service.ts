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
import { InferenceAssessment } from '../../inference/inference-assessment.entity';
import { ChunkingStrategy } from '../../chunking/enums/chunking-strategy.enum';
import { PlatformConfigService } from '../../common/config/platform-config.service';
import { VectorPlatform } from '../../projects/enums/platform.enum';
import { AiFactoryConfigService } from '../ai-factory-config.service';
import { AiWorkloadProfile } from '../workload-profile/workload-profile.entity';
import { AiModelSelection } from '../model-selection/model-selection.entity';
import { CatalogueModel } from '../model-selection/model-selection.types';
import { AiInferenceArchitecture } from '../inference-architecture/inference-architecture.entity';
import { AiRagAgentDesign } from './rag-agent.entity';
import { designRagAgent } from './rag-agent.engine';
import { CreateRagAgentDesignDto } from './create-rag-agent-design.dto';
import { ModelFacts, RagAgentContext, RagAgentResult, ToolAccess } from './rag-agent.types';

export type RagAgentSource = { source: 'user' | 'workload_profile' | 'discovery' | 'data_pipeline' | 'vector_db_selection' | 'model_selection' | 'inference' | 'inference_architecture' | 'default'; detail: string };

const RAG_CLASSES = ['rag', 'copilot', 'search', 'hybrid'];
const RAG_WORKLOADS = ['rag', 'question_answering', 'search', 'copilot'];
const MULTI_TURN_WORKLOADS = ['copilot', 'agentic'];
/** Discovery's operational capability on the inference assessment's scale (as in the infrastructure design). */
const DISCOVERY_OPS: Record<string, string> = { none: 'none', part_time: 'part_time', dedicated_dba: 'part_time', platform_team: 'platform_team' };

export interface RagAgentInputs {
  project: Pick<Project, 'platform'>;
  profile: AiWorkloadProfile | null;
  discovery: DiscoveryAssessment | null;
  pipeline: DataPipelineDesign | null;
  adr: ArchitectureDecisionRecord | null;
  selection: AiModelSelection | null;
  inference: InferenceAssessment | null;
  architecture: AiInferenceArchitecture | null;
}

export interface RagAgentCatalogues {
  databases: Array<Record<string, any>>;
  models: CatalogueModel[];
  charsPerToken: number;
  defaultOutputTokens: number;
}

/** Pure: builds the design context from the latest records and says where each input came from. */
export function resolveRagAgentContext(dto: CreateRagAgentDesignDto, x: RagAgentInputs, c: RagAgentCatalogues) {
  if (!x.profile && !x.discovery) throw new BadRequestException('Nothing to design against yet - complete Discovery or the AI Workload Profile first.');
  const sources: Record<string, RagAgentSource> = {};
  const pv = x.profile ? `Workload Profile v${x.profile.version}` : '';
  const dv = x.discovery ? `Discovery v${x.discovery.version}` : '';
  const pick = <T>(key: string, own: T | undefined, derived: { value: T; source: RagAgentSource['source']; detail: string } | null, fallback: T, why: string): T => {
    if (own !== undefined) {
      sources[key] = { source: 'user', detail: 'set in the RAG / agent inputs' };
      return own;
    }
    if (derived) {
      sources[key] = { source: derived.source, detail: derived.detail };
      return derived.value;
    }
    sources[key] = { source: 'default', detail: why };
    return fallback;
  };

  // scope
  const classes = x.profile?.result.architecture.components ?? [];
  const workloads = ((x.profile?.inputs.workloadTypes.value as string[] | null) ?? []).map(String);
  const profileRag = classes.some((k) => RAG_CLASSES.includes(k)) || workloads.some((w) => RAG_WORKLOADS.includes(w));
  const profileAgent = classes.includes('agent') || workloads.includes('agentic');
  const rag = pick(
    'includeRag',
    dto.includeRag,
    x.profile ? { value: profileRag, source: 'workload_profile', detail: `${pv}: ${x.profile.result.architecture.label ?? 'architecture'}` } : x.discovery ? { value: x.discovery.requiresSemanticSearch || x.discovery.requiresSimilaritySearch, source: 'discovery', detail: `${dv}: semantic / similarity search` } : null,
    false,
    'not stated',
  );
  const agent = pick('includeAgent', dto.includeAgent, x.profile ? { value: profileAgent, source: 'workload_profile', detail: `${pv}: ${x.profile.result.architecture.label ?? 'architecture'}` } : null, false, 'no Workload Profile - agents not assumed');
  if (!rag && !agent) throw new BadRequestException('Neither RAG nor an agent is in scope for this workload - include one explicitly to design it.');

  // vector database
  const platform = x.adr ? (x.project.platform && x.project.platform !== VectorPlatform.UNDETERMINED ? x.project.platform : x.adr.decision) : null;
  const entry = platform ? c.databases.find((d) => d.id === platform) : undefined;
  if (platform) sources.vectorPlatform = { source: 'vector_db_selection', detail: `Vector DB decision: ${platform}${platform !== x.adr!.decision ? ' (manual override on the project)' : ''}` };

  // data pipeline
  const p = x.pipeline;
  const chunkTokens = p ? (p.chunkingStrategy === ChunkingStrategy.TOKEN_BASED ? p.chunkSize : Math.ceil(p.chunkSize / c.charsPerToken)) : null;
  if (p) sources.pipeline = { source: 'data_pipeline', detail: `Data Pipeline Design v${p.version}: ${p.embeddingModelId}, ~${chunkTokens} tokens per chunk` };

  // models
  const facts = (m: { id: string; label: string; family: string } | null): ModelFacts | null => {
    if (!m) return null;
    const cm = c.models.find((k) => k.id === m.id);
    return { id: m.id, label: m.label, family: m.family, contextWindow: cm?.contextWindow ?? 8192, toolCalling: !!cm?.capabilities.includes('tool_calling'), structuredOutput: !!cm?.capabilities.includes('structured_output') };
  };
  const primary = facts(x.selection?.result.primary ?? null);
  const fallback = facts(x.selection?.result.fallback ?? null);
  if (x.selection) sources.models = { source: 'model_selection', detail: `Model Selection v${x.selection.version}: primary ${primary?.label ?? 'none'}` };

  // latency
  const latency = x.architecture?.result.architecture?.sla.latency ?? [];
  const ttft = latency.find((l) => l.metric === 'Time to first token');
  const tpot = latency.find((l) => l.metric === 'Time per output token');
  if (x.architecture) sources.latency = { source: 'inference_architecture', detail: `Inference Architecture v${x.architecture.version}: latency estimates` };
  const profileTtft = x.profile?.inputs.targetTtftMs.value as number | null | undefined;
  const ttftTargetMs = x.inference?.inputsUsed.ttftTargetMs ?? profileTtft ?? null;
  sources.ttftTarget = x.inference ? { source: 'inference', detail: `Inference assessment v${x.inference.version}: TTFT target` } : profileTtft ? { source: 'workload_profile', detail: `${pv}: target TTFT` } : { source: 'default', detail: 'no TTFT target' };
  const e2eTargetMs = (x.profile?.inputs.targetLatencyMs.value as number | null | undefined) ?? null;

  const targets = (x.profile?.inputs.deploymentTargets.value as string[] | null) ?? [];
  const onPremOnly = targets.length === 1 && targets[0] === 'on_premises';
  const profileGpu = x.profile?.inputs.hasGpu.value as boolean | null | undefined;

  const citationsRequired = pick('citationsRequired', dto.citationsRequired, null, rag, rag ? 'RAG answers cite sources by default' : 'no RAG');
  const multiTurn = pick(
    'multiTurn',
    dto.multiTurn,
    x.profile ? { value: workloads.some((w) => MULTI_TURN_WORKLOADS.includes(w)) || classes.includes('copilot'), source: 'workload_profile', detail: `${pv}: copilot / agentic workloads are conversational` } : null,
    false,
    'not stated - single request',
  );
  const toolAccess = pick<ToolAccess>('toolAccess', dto.toolAccess, null, agent ? 'read_only' : 'none', agent ? 'not stated - read-only tools assumed' : 'no agent');
  const longTermMemory = pick('longTermMemory', dto.longTermMemory, null, false, 'not stated - no cross-session memory');
  const openEndedTasks = pick('openEndedTasks', dto.openEndedTasks, null, false, agent ? 'not stated - known flows assumed' : 'no agent');

  const context: RagAgentContext = {
    rag,
    agent,
    architectureClass: x.profile?.result.architecture.class ?? null,
    requiresHybridSearch: x.discovery?.requiresHybridSearch ?? false,
    requiresFullTextSearch: x.discovery?.requiresFullTextSearch ?? false,
    requiresMetadataFiltering: x.discovery?.requiresMetadataFiltering ?? false,
    requiresReranking: x.discovery?.requiresReranking ?? false,
    requiresTenantIsolation: x.discovery?.requiresTenantIsolation ?? false,
    topK: x.discovery?.topK ?? 10,
    precisionTarget: x.discovery?.precisionTarget ?? null,
    vectorSearchP95Ms: x.discovery?.targetP95LatencyMs ?? null,
    vectorPlatform: platform,
    nativeHybrid: entry ? !!entry.supportsHybridSearch : null,
    nativeFiltering: entry ? !!entry.supportsMetadataFiltering : null,
    chunkTokens,
    embeddingModel: p?.embeddingModelId ?? null,
    embeddingSelfHosted: p ? p.embeddingProviderId === 'open_source' : null,
    metadataFields: (p?.metadataFields ?? []).map((f) => ({ name: f.name, filterable: f.filterable ?? true, searchable: f.searchable ?? false })),
    primary,
    fallback,
    accuracyRequirement: x.selection?.requirements.accuracyRequirement ?? 'standard',
    latencyPriority: x.selection?.requirements.latencyPriority ?? 'medium',
    ttftP95Ms: ttft?.p95 ?? null,
    tpotMs: tpot?.p50 ?? null,
    outputTokens: x.inference?.inputsUsed.avgOutputTokens ?? c.defaultOutputTokens,
    ttftTargetMs,
    e2eTargetMs,
    onPremOnly,
    thirdPartyApiAllowed: x.inference ? x.inference.inputsUsed.allowThirdPartyApi : !onPremOnly,
    restrictedData: x.profile?.result.dataClassification.level === 'restricted',
    containsPii: !!(x.discovery?.containsPii || x.profile?.inputs.containsPii.value),
    businessCriticality: (x.profile?.inputs.businessCriticality.value as string | null | undefined) ?? null,
    opsCapability: x.inference ? String(x.inference.inputsUsed.opsCapability) : x.discovery ? (DISCOVERY_OPS[x.discovery.operationalCapability] ?? 'part_time') : 'part_time',
    hasGpu: profileGpu ?? x.discovery?.hasGpu ?? null,
    policyEngine: !!x.architecture?.result.architecture,
    citationsRequired,
    multiTurn,
    toolAccess,
    longTermMemory,
    openEndedTasks,
  };
  if (x.discovery) sources.searchRequirements = { source: 'discovery', detail: `${dv}: hybrid / full-text / filtering / reranking, top-K ${context.topK}` };
  return { context, sources };
}

@Injectable()
export class RagAgentDesignService {
  private readonly logger = new Logger(RagAgentDesignService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly cfg: AiFactoryConfigService,
    private readonly platformConfig: PlatformConfigService,
    @InjectRepository(AiRagAgentDesign) private readonly designs: Repository<AiRagAgentDesign>,
    @InjectRepository(AiWorkloadProfile) private readonly profiles: Repository<AiWorkloadProfile>,
    @InjectRepository(DiscoveryAssessment) private readonly discovery: Repository<DiscoveryAssessment>,
    @InjectRepository(DataPipelineDesign) private readonly pipelines: Repository<DataPipelineDesign>,
    @InjectRepository(ArchitectureDecisionRecord) private readonly adrs: Repository<ArchitectureDecisionRecord>,
    @InjectRepository(AiModelSelection) private readonly selections: Repository<AiModelSelection>,
    @InjectRepository(InferenceAssessment) private readonly inference: Repository<InferenceAssessment>,
    @InjectRepository(AiInferenceArchitecture) private readonly architectures: Repository<AiInferenceArchitecture>,
  ) {}

  private async resolve(projectId: string, requester: AuthenticatedUser, dto: CreateRagAgentDesignDto) {
    const project = await this.projectsService.findOne(projectId, requester);
    const where = { project: { id: projectId } };
    const order = { createdAt: 'DESC' as const };
    const [profile, discovery, pipeline, adr, selection, inference, architecture] = await Promise.all([
      this.profiles.findOne({ where, order }),
      this.discovery.findOne({ where, order }),
      this.pipelines.findOne({ where, order }),
      this.adrs.findOne({ where, order }),
      this.selections.findOne({ where, order }),
      this.inference.findOne({ where, order }),
      this.architectures.findOne({ where, order }),
    ]);
    const cat = this.cfg.getRagAgentCatalogue();
    return resolveRagAgentContext(
      dto,
      { project, profile, discovery, pipeline, adr, selection, inference, architecture },
      { databases: this.platformConfig.getSupportedPlatforms(), models: this.cfg.getModelCatalogue().models, charsPerToken: this.cfg.getEmbeddingEligibilityRules().charsPerToken, defaultOutputTokens: cat.assumptions.tokens.defaultOutputReserve },
    );
  }

  async getDefaults(projectId: string, requester: AuthenticatedUser): Promise<{ context: RagAgentContext; sources: Record<string, RagAgentSource>; preview: RagAgentResult }> {
    const resolved = await this.resolve(projectId, requester, {});
    return { ...resolved, preview: designRagAgent(resolved.context, this.cfg.getRagAgentCatalogue()) };
  }

  async submit(projectId: string, requester: AuthenticatedUser, dto: CreateRagAgentDesignDto): Promise<AiRagAgentDesign> {
    const { context, sources } = await this.resolve(projectId, requester, dto);
    const result = designRagAgent(context, this.cfg.getRagAgentCatalogue());
    const version = (await this.designs.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.designs.save(
      this.designs.create({ project: { id: projectId } as Project, createdBy: { id: requester.id } as User, version, submitted: dto, context, sources, result, rulesVersion: result.rulesVersion }),
    );
    this.logger.log(`user=${requester.email} action=design_rag_agent projectId=${projectId} version=${version} scope=${[context.rag && 'rag', context.agent && 'agent'].filter(Boolean).join('+')} choices=${result.decisions.map((d) => d.chosen?.id ?? 'none').join(',')}`);
    return saved;
  }

  async getLatest(projectId: string, requester: AuthenticatedUser): Promise<AiRagAgentDesign | null> {
    await this.projectsService.findOne(projectId, requester);
    return this.designs.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
