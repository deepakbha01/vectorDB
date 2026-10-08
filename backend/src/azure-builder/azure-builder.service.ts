import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/auth.service';
import { Project } from '../projects/project.entity';
import { ProjectsService } from '../projects/projects.service';
import { User } from '../users/user.entity';
import { AzureConnection } from './azure-connection.entity';
import { AzureEnvironmentProfile } from './azure-environment-profile.entity';
import { AzureRole, ConnectionSource, ProfileSource } from './azure-builder.enums';
import { DISCOVERY_QUERIES, SAMPLE_FORM_INPUT, SAMPLE_RESOURCE_GRAPH_ROWS, SAMPLE_SUBSCRIPTION_ID } from './discovery-queries';
import { buildEnvironmentProfile, deriveConstraints, ProfileFormInput, readResourceGraphRows, validateEnvironmentProfile } from './environment-profile';
import { CreateAzureConnectionDto, CreateEnvironmentProfileDto } from './dto/azure-builder.dto';
import { CreateUseCaseDto, OverridePatternDto } from './dto/use-case.dto';
import { AzureUseCase } from './azure-use-case.entity';
import { DiscoveryService } from '../discovery/discovery.service';
import { buildUseCaseSpec, classifyUseCase, IntakeAnswers, SolutionPattern, SOLUTION_PATTERNS, validateIntake } from './use-case-spec';
import { prefillIntake } from './use-case-prefill';
import { AzureArchitecture } from './azure-architecture.entity';
import { ArchitectureError, ArchitectureSpec, DEFAULT_OPTIONS, designArchitecture } from './architecture';
import { loadAzureCatalog } from './architecture-catalog';
import { GenerateArchitectureDto } from './dto/architecture.dto';
import { AzureIacBundle } from './azure-iac-bundle.entity';
import { GenerateIacDto } from './dto/iac.dto';
import { deriveWorkload, generateIacBundle, TARGET_ENVS, TargetEnv } from './iac-bundle';
import { validateIacBundle } from './iac-validate';
import { zipFiles } from './zip';
import { AzureWhatIf } from './azure-what-if.entity';
import { AzureApproval } from './azure-approval.entity';
import { CreateApprovalDto, RunWhatIfDto } from './dto/approval.dto';
import { normaliseEnvInputs, validateEnvInputs } from './iac-inputs';
import { assessWhatIf, bundleHash, parseArmWhatIf, planWhatIf, RAI_CHECKLIST, ValidationReport, WhatIfChange } from './validate-approve';

/** What the declared role allows. Offline it is the user's word; the live wave reads Microsoft.Authorization. */
export interface PermissionLevel {
  role: AzureRole;
  canDesign: boolean;
  canDeploy: boolean;
  verified: boolean;
  note: string;
}

export function permissionFor(role: AzureRole, source: ConnectionSource): PermissionLevel {
  const canDeploy = role === AzureRole.OWNER || role === AzureRole.CONTRIBUTOR;
  const verified = source === ConnectionSource.LIVE;
  const note = canDeploy
    ? `${role === AzureRole.OWNER ? 'Owner' : 'Contributor'} can design and deploy into this scope.`
    : role === AzureRole.READER
      ? 'Reader can design but deployment is blocked - ask for Contributor on the target resource group.'
      : 'Role not known - design is allowed; deployment stays blocked until the role is confirmed.';
  return { role, canDesign: true, canDeploy, verified, note: verified ? note : `${note} (Declared, not yet verified against Azure.)` };
}

/** The bundle's metadata for the state endpoint; the files come from the history or the download. */
function withoutFiles(b: AzureIacBundle): Omit<AzureIacBundle, 'files'> {
  const { files: _files, ...rest } = b;
  return rest;
}

export interface AzureBuilderState {
  connection: (AzureConnection & { permission: PermissionLevel }) | null;
  environmentProfile: AzureEnvironmentProfile | null;
  /** True when the latest profile was taken for an older connection (e.g. the region changed) - re-run Discover. */
  profileStale: boolean;
  /** Latest UseCaseSpec version (Phase 2), or null before intake. */
  useCase: AzureUseCase | null;
  /** Latest ArchitectureSpec version (Phase 3), or null before the first design. */
  architecture: AzureArchitecture | null;
  /** True when a newer use case or Environment Profile exists than the architecture was designed from. */
  architectureStale: boolean;
  /** Latest IaC bundle (Phase 4) without its files, or null. */
  iacBundle: Omit<AzureIacBundle, 'files'> | null;
  /** True when a newer architecture exists than the bundle was generated from. */
  iacStale: boolean;
}

/**
 * Azure AI Factory Builder - Phases 0 (Connect), 1 (Discover), 2 (Use case intake), 3 (Architect), 4 (Generate IaC)
 * and 5 (Validate & approve).
 * Offline-first: no Azure call is made and no credential is accepted or stored.
 */
@Injectable()
export class AzureBuilderService {
  private readonly logger = new Logger(AzureBuilderService.name);

  constructor(
    @InjectRepository(AzureConnection) private readonly connections: Repository<AzureConnection>,
    @InjectRepository(AzureEnvironmentProfile) private readonly profiles: Repository<AzureEnvironmentProfile>,
    @InjectRepository(AzureUseCase) private readonly useCases: Repository<AzureUseCase>,
    @InjectRepository(AzureArchitecture) private readonly architectures: Repository<AzureArchitecture>,
    @InjectRepository(AzureIacBundle) private readonly iacBundles: Repository<AzureIacBundle>,
    @InjectRepository(AzureWhatIf) private readonly whatIfs: Repository<AzureWhatIf>,
    @InjectRepository(AzureApproval) private readonly approvals: Repository<AzureApproval>,
    private readonly projectsService: ProjectsService,
    private readonly discoveryService: DiscoveryService,
  ) {}

  async getState(projectId: string, user: AuthenticatedUser): Promise<AzureBuilderState> {
    await this.projectsService.findOne(projectId, user); // enforces access
    const connection = await this.latestConnection(projectId);
    const environmentProfile = await this.profiles.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
    const active = connection?.active ? connection : null;
    const useCase = await this.latestUseCase(projectId);
    const architecture = await this.latestArchitecture(projectId);
    const bundle = await this.latestIacBundle(projectId);
    return {
      connection: active ? { ...active, permission: permissionFor(active.role, active.source) } : null,
      environmentProfile,
      profileStale: !!(active && environmentProfile && environmentProfile.connectionVersion !== active.version),
      useCase,
      architecture,
      architectureStale: !!(architecture && (architecture.useCaseVersion !== useCase?.version || architecture.profileVersion !== environmentProfile?.version)),
      iacBundle: bundle ? withoutFiles(bundle) : null,
      iacStale: !!(bundle && bundle.architectureVersion !== architecture?.version),
    };
  }

  // ---- Phase 2 - Use case intake ----

  /** Wizard defaults from what the project already knows (name, use case, connection, Evectorize Discovery). */
  async intakePrefill(projectId: string, user: AuthenticatedUser) {
    const project = await this.projectsService.findOne(projectId, user);
    const connection = await this.latestConnection(projectId);
    const discovery = await this.discoveryService.getLatest(projectId, user).catch(() => null);
    return {
      ...prefillIntake(project, connection?.active ? connection : null, discovery?.assessment ?? null),
      patterns: SOLUTION_PATTERNS,
    };
  }

  /** Classifies the answers and stores a new UseCaseSpec version (spec 4.3). */
  async submitUseCase(projectId: string, user: AuthenticatedUser, dto: CreateUseCaseDto) {
    await this.projectsService.findOne(projectId, user);
    const answers = this.toAnswers(dto);
    const problems = validateIntake(answers);
    if (problems.length) throw new BadRequestException(problems);
    const classification = classifyUseCase(answers);
    const saved = await this.saveUseCase(projectId, user, buildUseCaseSpec(answers, classification, user.email), classification);
    this.logger.log(`user=${user.email} action=azure_builder_intake projectId=${projectId} version=${saved.version} pattern=${classification.pattern} risk=${classification.riskClass}`);
    return saved;
  }

  /** Records an architect's override of the classified pattern as a new version; the classifier's output is kept. */
  async overridePattern(projectId: string, user: AuthenticatedUser, dto: OverridePatternDto) {
    await this.projectsService.findOne(projectId, user);
    const latest = await this.latestUseCase(projectId);
    if (!latest) throw new BadRequestException('Complete the use case intake before overriding its pattern.');
    const { pattern: _pattern, owner, ...answers } = latest.spec;
    const spec = buildUseCaseSpec(answers, latest.classification, owner, { pattern: dto.pattern as SolutionPattern, reason: dto.reason.trim(), by: user.email });
    const saved = await this.saveUseCase(projectId, user, spec, latest.classification);
    this.logger.log(`user=${user.email} action=azure_builder_pattern_override projectId=${projectId} version=${saved.version} from=${latest.classification.pattern} to=${dto.pattern}`);
    return saved;
  }

  async useCaseHistory(projectId: string, user: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, user);
    return this.useCases.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  private async saveUseCase(projectId: string, user: AuthenticatedUser, spec: AzureUseCase['spec'], classification: AzureUseCase['classification']) {
    const version = (await this.useCases.count({ where: { project: { id: projectId } } })) + 1;
    return this.useCases.save(this.useCases.create({ project: { id: projectId } as Project, createdBy: { id: user.id } as User, version, spec, classification }));
  }

  private latestUseCase(projectId: string) {
    return this.useCases.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  /** Normalises the DTO: trims text, lower-cases regions, drops blank KPIs. */
  private toAnswers(dto: CreateUseCaseDto): IntakeAnswers {
    return {
      name: dto.name.trim(),
      business: { problem: dto.business.problem.trim(), kpis: dto.business.kpis.map((k) => k.trim()).filter(Boolean), sponsor: dto.business.sponsor.trim(), costCenter: dto.business.costCenter.trim() },
      users: { type: dto.users.type, count: dto.users.count, peakConcurrent: dto.users.peakConcurrent, channels: [...new Set(dto.users.channels)] },
      data: dto.data.map((d) => ({ ...d, source: d.source.trim(), format: d.format.trim() })),
      constraints: {
        regions: [...new Set(dto.constraints.regions.map((r) => r.trim().toLowerCase().replace(/\s+/g, '')).filter(Boolean))],
        dataResidency: dto.constraints.dataResidency?.trim() || null,
        compliance: dto.constraints.compliance.map((c) => c.trim()).filter(Boolean),
        latencyMs: dto.constraints.latencyMs ?? null,
        availability: dto.constraints.availability?.trim() || null,
        monthlyBudgetUsd: dto.constraints.monthlyBudgetUsd ?? null,
      },
      environment: dto.environment,
    };
  }

  // ---- Phase 3 - Architect ----

  /** Runs the rules engine on the latest use case and Environment Profile and stores a new ArchitectureSpec version. */
  async generateArchitecture(projectId: string, user: AuthenticatedUser, dto: GenerateArchitectureDto) {
    await this.projectsService.findOne(projectId, user);
    const useCase = await this.latestUseCase(projectId);
    if (!useCase) throw new BadRequestException('Complete the use case intake (Phase 2) before designing the architecture.');
    const connection = await this.latestConnection(projectId);
    if (!connection?.active) throw new BadRequestException('Connect a target subscription (Phase 0) before designing the architecture.');
    const profile = await this.profiles.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
    if (!profile) throw new BadRequestException('Run Discover (Phase 1) before designing the architecture.');
    if (profile.connectionVersion !== connection.version) throw new BadRequestException('The connection changed since the last Discover - run Discover (Phase 1) again first.');

    const options = {
      apiGateway: dto.apiGateway === undefined ? DEFAULT_OPTIONS.apiGateway : dto.apiGateway,
      chatHistory: dto.chatHistory ?? DEFAULT_OPTIONS.chatHistory,
      deployment: dto.deployment ?? DEFAULT_OPTIONS.deployment,
    };
    let spec;
    try {
      spec = designArchitecture({
        useCase: useCase.spec,
        useCaseId: useCase.id,
        useCaseVersion: useCase.version,
        profile: profile.profile,
        profileVersion: profile.version,
        connection: { region: connection.region, deploymentModel: connection.deploymentModel },
        options,
        catalog: loadAzureCatalog(),
      });
    } catch (err) {
      if (err instanceof ArchitectureError) throw new BadRequestException(err.message);
      throw err;
    }
    const version = (await this.architectures.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.architectures.save(
      this.architectures.create({ project: { id: projectId } as Project, createdBy: { id: user.id } as User, version, useCaseVersion: useCase.version, profileVersion: profile.version, spec }),
    );
    this.logger.log(`user=${user.email} action=azure_builder_architect projectId=${projectId} version=${version} components=${spec.components.length} monthlyUsd=${spec.cost.monthlyUsd}`);
    return saved;
  }

  async architectureHistory(projectId: string, user: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, user);
    return this.architectures.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  private latestArchitecture(projectId: string) {
    return this.architectures.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  // ---- Phase 4 - Generate IaC ----

  /**
   * Generates the IaC bundle from the latest architecture, sized per environment, and compiles and lints
   * it when a Bicep CLI is configured. A bundle that does not compile is not saved (spec 4.5).
   */
  async generateIac(projectId: string, user: AuthenticatedUser, dto: GenerateIacDto) {
    const state = await this.getState(projectId, user);
    const architecture = state.architecture;
    if (!architecture) throw new BadRequestException('Design the architecture (Phase 3) before generating infrastructure code.');
    if (state.architectureStale) throw new BadRequestException('The use case or the Environment Profile changed since the architecture was designed - design it again (Phase 3) first.');
    const useCase = await this.useCases.findOne({ where: { project: { id: projectId }, version: architecture.useCaseVersion } });
    const profile = await this.profiles.findOne({ where: { project: { id: projectId }, version: architecture.profileVersion } });
    const connection = state.connection;
    if (!useCase || !profile || !connection) throw new BadRequestException('The inputs this architecture was designed from are no longer available - design it again (Phase 3).');

    const catalog = loadAzureCatalog();
    const spec = architecture.spec;
    const specsByEnv = {} as Record<TargetEnv, ArchitectureSpec>;
    try {
      for (const env of TARGET_ENVS) {
        specsByEnv[env] = designArchitecture({
          useCase: { ...useCase.spec, environment: env },
          useCaseId: useCase.id,
          useCaseVersion: useCase.version,
          profile: profile.profile,
          profileVersion: profile.version,
          connection: { region: connection.region, deploymentModel: connection.deploymentModel },
          options: spec.options,
          catalog,
        });
      }
    } catch (err) {
      if (err instanceof ArchitectureError) throw new BadRequestException(err.message);
      throw err;
    }
    const workload = dto.workload ?? deriveWorkload(spec.useCaseName);
    const previous = await this.latestIacBundle(projectId);
    const inputs = normaliseEnvInputs(dto.inputs ?? previous?.inputs ?? {});
    const inputProblems = validateEnvInputs(inputs, profile.profile.network.vnets);
    if (inputProblems.length) throw new BadRequestException(inputProblems);
    const bundle = generateIacBundle({ spec, specsByEnv, architectureVersion: architecture.version, workload, catalog, inputs });
    const validation = await validateIacBundle(bundle.files, process.env.AZURE_BUILDER_BICEP_PATH || undefined);
    if (validation.status === 'failed') {
      const errors = validation.diagnostics.filter((d) => d.level === 'error');
      this.logger.error(`user=${user.email} action=azure_builder_iac_failed projectId=${projectId} architecture=${architecture.version} errors=${errors.length}`);
      throw new UnprocessableEntityException({ message: `The generated Bicep did not compile (${errors.length} error(s)); nothing was saved.`, errorCode: 'IAC_COMPILE_FAILED', details: { diagnostics: validation.diagnostics } });
    }
    const version = (await this.iacBundles.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.iacBundles.save(
      this.iacBundles.create({
        project: { id: projectId } as Project,
        createdBy: { id: user.id } as User,
        version,
        architectureVersion: architecture.version,
        workload,
        root: bundle.root,
        generator: bundle.generator,
        files: bundle.files,
        requiredInputs: bundle.requiredInputs,
        notes: bundle.notes,
        validation,
        inputs: bundle.inputs,
        missingInputs: bundle.missingInputs,
      }),
    );
    this.logger.log(`user=${user.email} action=azure_builder_iac projectId=${projectId} version=${version} architecture=${architecture.version} validation=${validation.status}`);
    return saved;
  }

  async iacHistory(projectId: string, user: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, user);
    return this.iacBundles.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  /** The bundle as a zip, inside its root folder. */
  async iacZip(projectId: string, user: AuthenticatedUser, version: number) {
    await this.projectsService.findOne(projectId, user);
    const bundle = await this.iacBundles.findOne({ where: { project: { id: projectId }, version } });
    if (!bundle) throw new NotFoundException(`IaC bundle v${version} was not found for this project.`);
    return { filename: `${bundle.root}-v${bundle.version}.zip`, buffer: zipFiles(bundle.files.map((f) => ({ path: `${bundle.root}/${f.path}`, content: f.content }))) };
  }

  // ---- Phase 5 - Validate & approve ----

  /**
   * Runs a what-if for one environment of the latest bundle - the offline plan, or a pasted ARM what-if - and
   * stores it with the validation report an approver decides on (spec 4.6).
   */
  async runWhatIf(projectId: string, user: AuthenticatedUser, dto: RunWhatIfDto) {
    const { bundle, architecture, useCase, profile, connection } = await this.approvalContext(projectId, user);
    const env = dto.environment;
    const catalog = loadAzureCatalog();
    const spec = architecture.spec;
    const plan = planWhatIf({
      spec,
      env,
      workload: bundle.workload,
      regionAbbreviation: catalog.iac.regionAbbreviations[spec.region] ?? spec.region.slice(0, 4),
      subscriptionId: connection.subscriptionId,
      resourceGroup: connection.resourceGroup,
      useCaseId: useCase.id,
      existingNames: [
        ...profile.profile.network.vnets.map((v) => v.name),
        ...profile.profile.monitoring.workspaces.map((w) => w.name),
        ...profile.profile.ai.existingAccounts.map((a) => a.name),
        ...profile.profile.security.keyVaults.map((k) => k.split('/').pop() ?? k),
      ],
    });
    let changes: WhatIfChange[] = plan;
    let status: 'succeeded' | 'failed' = 'succeeded';
    let armError: string | null = null;
    let armProblems: string[] = [];
    if (dto.source === 'arm') {
      if (!dto.result?.trim()) throw new BadRequestException('Paste the output of az deployment group what-if --no-pretty-print.');
      const parsed = parseArmWhatIf(dto.result, useCase.id);
      ({ changes, status } = parsed);
      armError = parsed.error;
      armProblems = parsed.problems;
    }
    const assessment = assessWhatIf(changes, {
      spec, source: dto.source, allowedLocations: profile.profile.policy.allowedLocations, useCaseId: useCase.id,
      subscriptionId: connection.subscriptionId, resourceGroup: connection.resourceGroup, plan, armStatus: status, armError, armProblems,
    });

    const envSpec = this.designFor(useCase, profile, connection, spec.options, env, catalog);
    const missing = bundle.missingInputs?.[env];
    const blocking = [
      ...(missing === undefined ? ['This bundle predates required-input tracking - generate it again (Phase 4).'] : missing.map((k) => `${k} is blank in ${env}.bicepparam - fill it in on the Generate IaC page.`)),
      ...assessment.blocking,
    ];
    const risks = [
      ...assessment.risks,
      ...(bundle.validation.status !== 'passed' ? [`The Bicep was not compiled on the server (${bundle.validation.status}) - the pipeline lints it before deploying.`] : []),
      ...(bundle.inputs?.[env]?.containerImage ? [] : ['The container image is still the placeholder - the platform deploys, but not the assistant.']),
      ...(dto.source === 'planned' ? ['This is the offline plan, not an ARM what-if against the subscription - names ending in xxxx get their suffix at deployment.'] : []),
      // Design-time reminders the inputs have since answered are dropped.
      ...envSpec.warnings.filter((x) => !(x.startsWith('The spoke VNet needs an address range') && bundle.inputs?.[env]?.vnetAddressPrefix)),
    ];
    const report: ValidationReport = {
      environment: env,
      iacVersion: bundle.version,
      iacHash: bundleHash(bundle.files),
      architectureVersion: architecture.version,
      useCaseVersion: useCase.version,
      source: dto.source,
      compile: { status: bundle.validation.status, tool: bundle.validation.tool },
      missingInputs: missing ?? [],
      counts: assessment.counts,
      blocking,
      risks: [...new Set(risks)],
      monthlyUsd: envSpec.cost.monthlyUsd,
      budgetUsd: envSpec.cost.budgetUsd,
      riskClass: useCase.spec.pattern.riskClass,
      raiRequired: useCase.spec.pattern.riskClass === 'high',
      approvable: status === 'succeeded' && blocking.length === 0,
    };
    const saved = await this.whatIfs.save(
      this.whatIfs.create({ project: { id: projectId } as Project, createdBy: { id: user.id } as User, iacVersion: bundle.version, iacHash: report.iacHash, environment: env, source: dto.source, status, changes, report }),
    );
    this.logger.log(`user=${user.email} action=azure_builder_what_if projectId=${projectId} iac=${bundle.version} env=${env} source=${dto.source} status=${status} blocking=${blocking.length}`);
    return saved;
  }

  async whatIfHistory(projectId: string, user: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, user);
    return this.whatIfs.find({ where: { project: { id: projectId } }, order: { createdAt: 'DESC' } });
  }

  /**
   * Records an immutable decision bound to the bundle's hash (spec 4.6). Approval needs a successful,
   * unblocked what-if of exactly this bundle; the responsible-AI checklist for a high-risk use case
   * (spec 12); and, for prod, an approver other than the person who generated the IaC.
   */
  async decide(projectId: string, user: AuthenticatedUser, dto: CreateApprovalDto) {
    const { bundle, architecture, useCase } = await this.approvalContext(projectId, user);
    const env = dto.environment;
    const hash = bundleHash(bundle.files);
    const whatIf = await this.whatIfs.findOne({ where: { project: { id: projectId }, iacVersion: bundle.version, environment: env }, order: { createdAt: 'DESC' } });
    if (!whatIf || whatIf.iacHash !== hash) throw new BadRequestException(`Run a what-if for ${env} on IaC bundle v${bundle.version} first.`);
    const comments = dto.comments?.trim() || null;
    const raiChecklist = [...new Set(dto.raiChecklist ?? [])];
    if (dto.decision === 'rejected') {
      if (!comments || comments.length < 10) throw new BadRequestException('Say why the deployment is rejected (at least 10 characters).');
    } else {
      if (!whatIf.report.approvable) throw new BadRequestException(['Approval is blocked:', ...whatIf.report.blocking].join(' '));
      if (whatIf.report.raiRequired) {
        const missing = RAI_CHECKLIST.filter((r) => !raiChecklist.includes(r.id));
        if (missing.length) throw new BadRequestException(`This is a high-risk use case - confirm every responsible-AI checklist item (${missing.map((m) => m.id).join(', ')}).`);
      }
      if (env === 'prod' && bundle.createdBy?.id === user.id) {
        throw new ForbiddenException('Separation of duties: the person who generated this IaC cannot approve it for production. Ask another admin or architect.');
      }
    }
    const saved = await this.approvals.save(
      this.approvals.create({
        project: { id: projectId } as Project,
        approver: { id: user.id } as User,
        approverEmail: user.email,
        environment: env,
        decision: dto.decision,
        comments,
        iacVersion: bundle.version,
        iacHash: hash,
        architectureVersion: architecture.version,
        useCaseVersion: useCase.version,
        whatIfId: whatIf.id,
        evidence: whatIf.source === 'arm' ? 'arm-what-if' : 'offline-plan',
        raiChecklist,
      }),
    );
    this.logger.log(`user=${user.email} action=azure_builder_${dto.decision} projectId=${projectId} iac=${bundle.version} env=${env} hash=${hash.slice(0, 12)} evidence=${saved.evidence}`);
    return saved;
  }

  async approvalHistory(projectId: string, user: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, user);
    return this.approvals.find({ where: { project: { id: projectId } }, order: { createdAt: 'DESC' } });
  }

  /** The latest bundle and the exact inputs it was generated from; refuses a stale chain. */
  private async approvalContext(projectId: string, user: AuthenticatedUser) {
    const state = await this.getState(projectId, user);
    const bundle = await this.iacBundles.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' }, relations: { createdBy: true } });
    if (!bundle) throw new BadRequestException('Generate the infrastructure code (Phase 4) first.');
    if (state.architectureStale || state.iacStale) throw new BadRequestException('The design changed since this bundle was generated - design and generate it again (Phases 3-4) first.');
    const architecture = await this.architectures.findOne({ where: { project: { id: projectId }, version: bundle.architectureVersion } });
    const useCase = architecture && (await this.useCases.findOne({ where: { project: { id: projectId }, version: architecture.useCaseVersion } }));
    const profile = architecture && (await this.profiles.findOne({ where: { project: { id: projectId }, version: architecture.profileVersion } }));
    if (!architecture || !useCase || !profile || !state.connection) throw new BadRequestException('The inputs this bundle was generated from are no longer available - generate it again.');
    return { bundle, architecture, useCase, profile, connection: state.connection };
  }

  private designFor(useCase: AzureUseCase, profile: AzureEnvironmentProfile, connection: AzureConnection, options: ArchitectureSpec['options'], env: TargetEnv, catalog = loadAzureCatalog()) {
    return designArchitecture({
      useCase: { ...useCase.spec, environment: env },
      useCaseId: useCase.id,
      useCaseVersion: useCase.version,
      profile: profile.profile,
      profileVersion: profile.version,
      connection: { region: connection.region, deploymentModel: connection.deploymentModel },
      options,
      catalog,
    });
  }

  private latestIacBundle(projectId: string) {
    return this.iacBundles.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  async connect(projectId: string, user: AuthenticatedUser, dto: CreateAzureConnectionDto) {
    await this.projectsService.findOne(projectId, user);
    const version = (await this.connections.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.connections.save(
      this.connections.create({
        ...dto,
        region: dto.region.toLowerCase(),
        subscriptionName: dto.subscriptionName ?? null,
        source: ConnectionSource.DECLARED,
        active: true,
        version,
        project: { id: projectId } as Project,
        createdBy: { id: user.id } as User,
      }),
    );
    this.logger.log(`user=${user.email} action=azure_builder_connect projectId=${projectId} version=${version}`);
    return { ...saved, permission: permissionFor(saved.role, saved.source) };
  }

  /** Records a disconnected version - history is kept, nothing is deleted. */
  async disconnect(projectId: string, user: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, user);
    const current = await this.latestConnection(projectId);
    if (!current?.active) throw new BadRequestException('This project has no active Azure connection.');
    const { id: _id, createdAt: _createdAt, ...rest } = current;
    await this.connections.save(this.connections.create({ ...rest, active: false, version: current.version + 1, createdBy: { id: user.id } as User }));
    return { disconnected: true, subscriptionId: current.subscriptionId };
  }

  async connectionHistory(projectId: string, user: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, user);
    return this.connections.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  async discover(projectId: string, user: AuthenticatedUser, dto: CreateEnvironmentProfileDto) {
    await this.projectsService.findOne(projectId, user);
    const connection = await this.latestConnection(projectId);
    if (!connection?.active) throw new BadRequestException('Connect a target subscription (Phase 0) before running Discover.');

    let rows: Array<Record<string, unknown>> = [];
    let problems: string[] = [];
    let form: ProfileFormInput = (dto.form ?? {}) as ProfileFormInput;
    let subscriptionId = connection.subscriptionId;
    if (dto.source === ProfileSource.SAMPLE) {
      rows = SAMPLE_RESOURCE_GRAPH_ROWS;
      form = SAMPLE_FORM_INPUT;
      subscriptionId = SAMPLE_SUBSCRIPTION_ID;
      problems = ['Sample environment - not read from your subscription. Replace it with your own Resource Graph output before relying on it.'];
    } else if (dto.source === ProfileSource.RESOURCE_GRAPH) {
      if (dto.resourceGraph === undefined || dto.resourceGraph === null || dto.resourceGraph === '') {
        throw new BadRequestException('Paste the Resource Graph output, or choose the form or the sample.');
      }
      ({ rows, problems } = readResourceGraphRows(dto.resourceGraph));
      if (rows.length === 0 && problems.length) throw new BadRequestException(problems.join(' '));
    }

    const profile = buildEnvironmentProfile(subscriptionId, rows, form, new Date().toISOString());
    const errors = validateEnvironmentProfile(profile);
    if (errors.length) throw new BadRequestException(errors);

    const version = (await this.profiles.count({ where: { project: { id: projectId } } })) + 1;
    const saved = await this.profiles.save(
      this.profiles.create({
        project: { id: projectId } as Project,
        createdBy: { id: user.id } as User,
        version,
        connectionVersion: connection.version,
        source: dto.source,
        profile,
        constraints: deriveConstraints(profile, connection.region),
        problems,
      }),
    );
    this.logger.log(`user=${user.email} action=azure_builder_discover projectId=${projectId} version=${version} source=${dto.source} rows=${rows.length}`);
    return saved;
  }

  async profileHistory(projectId: string, user: AuthenticatedUser) {
    await this.projectsService.findOne(projectId, user);
    return this.profiles.find({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }

  discoveryQueries() {
    return DISCOVERY_QUERIES;
  }

  private latestConnection(projectId: string) {
    return this.connections.findOne({ where: { project: { id: projectId } }, order: { version: 'DESC' } });
  }
}
