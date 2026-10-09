import { Body, Controller, Get, Headers, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { UserRole } from '../users/user.entity';
import { AzureBuilderEnabledGuard } from './azure-builder-enabled.guard';
import { AzureBuilderService } from './azure-builder.service';
import { CreateAzureConnectionDto, CreateEnvironmentProfileDto, CreateLiveConnectionDto } from './dto/azure-builder.dto';
import { CreateUseCaseDto, OverridePatternDto } from './dto/use-case.dto';
import { GenerateArchitectureDto } from './dto/architecture.dto';
import { GenerateIacDto } from './dto/iac.dto';
import { CreateApprovalDto, CreateDeploymentDto, RunWhatIfDto } from './dto/approval.dto';
import { SetBudgetDto, TeardownDto } from './dto/operate.dto';

/** The user's Azure sign-in for one request (live mode). Read from this header only - never from a body, which the audit log records. */
export const AZURE_TOKEN_HEADER = 'x-azure-token';

/** Live-Azure settings the browser needs before it can sign in (the Entra app registration). Not project-scoped: the sign-in callback has no project. */
@ApiTags('azure-builder')
@ApiBearerAuth()
@UseGuards(AzureBuilderEnabledGuard, JwtAuthGuard)
@Controller('azure-builder')
export class AzureBuilderConfigController {
  constructor(private readonly service: AzureBuilderService) {}

  @Get('live-config')
  liveConfig() {
    return this.service.liveConfig();
  }
}

/**
 * Azure AI Factory Builder, scoped to a project. Reads are open to project
 * members; changes to admins and architects. Hidden unless AZURE_BUILDER_ENABLED.
 */
@ApiTags('azure-builder')
@ApiBearerAuth()
@UseGuards(AzureBuilderEnabledGuard, JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/azure-builder')
export class AzureBuilderController {
  constructor(private readonly service: AzureBuilderService) {}

  /** Current connection (with permission level), latest Environment Profile and whether it is stale. */
  @Get()
  state(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getState(projectId, user);
  }

  // ---- Phase 0 - Connect ----

  @Post('connections')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  connect(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateAzureConnectionDto) {
    return this.service.connect(projectId, user, dto);
  }

  @Post('connections/disconnect')
  @HttpCode(200)
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  disconnect(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.disconnect(projectId, user);
  }

  // ---- Live Azure (Wave 6) - the ARM token travels in the X-Azure-Token header ----

  /** Subscriptions the signed-in Azure user can see. */
  @Get('live/subscriptions')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  liveSubscriptions(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Headers(AZURE_TOKEN_HEADER) token: string | undefined) {
    return this.service.liveSubscriptions(projectId, user, token);
  }

  @Get('live/subscriptions/:subscriptionId/resource-groups')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  liveResourceGroups(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Headers(AZURE_TOKEN_HEADER) token: string | undefined,
  ) {
    return this.service.liveResourceGroups(projectId, user, token, subscriptionId);
  }

  /** Connects to a target verified against Azure; the role recorded is the one Azure reports. */
  @Post('connections/live')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  connectLive(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Headers(AZURE_TOKEN_HEADER) token: string | undefined, @Body() dto: CreateLiveConnectionDto) {
    return this.service.connectLive(projectId, user, token, dto);
  }

  @Get('connections')
  connections(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.connectionHistory(projectId, user);
  }

  // ---- Phase 1 - Discover ----

  @Post('environment-profiles')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  discover(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateEnvironmentProfileDto, @Headers(AZURE_TOKEN_HEADER) token: string | undefined) {
    return this.service.discover(projectId, user, dto, token);
  }

  @Get('environment-profiles')
  profiles(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.profileHistory(projectId, user);
  }

  /** The Resource Graph queries to run in the Azure portal (offline mode). */
  @Get('discovery-queries')
  queries() {
    return this.service.discoveryQueries();
  }

  // ---- Phase 2 - Use case intake ----

  /** Wizard defaults from the project, its connection and its Evectorize Discovery, with where each came from. */
  @Get('use-cases/prefill')
  prefill(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.intakePrefill(projectId, user);
  }

  /** Classifies the wizard answers and stores a new UseCaseSpec version. */
  @Post('use-cases')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  submitUseCase(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateUseCaseDto) {
    return this.service.submitUseCase(projectId, user, dto);
  }

  /** Overrides the classified pattern with a reason; recorded as a new version. */
  @Post('use-cases/override')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  overridePattern(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: OverridePatternDto) {
    return this.service.overridePattern(projectId, user, dto);
  }

  @Get('use-cases')
  useCases(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.useCaseHistory(projectId, user);
  }

  // ---- Phase 3 - Architect ----

  /** Designs the architecture from the latest use case and Environment Profile, with the architect's toggles. New version each call. */
  @Post('architectures')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  generateArchitecture(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: GenerateArchitectureDto) {
    return this.service.generateArchitecture(projectId, user, dto);
  }

  @Get('architectures')
  architectures(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.architectureHistory(projectId, user);
  }

  // ---- Phase 4 - Generate IaC ----

  /** Generates (and, with a Bicep CLI, compiles and lints) the IaC bundle from the latest architecture. New version each call. */
  @Post('iac')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  generateIac(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: GenerateIacDto) {
    return this.service.generateIac(projectId, user, dto);
  }

  @Get('iac')
  iacBundles(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.iacHistory(projectId, user);
  }

  /** The bundle as a zip (spec 11.2 layout inside one folder). */
  @Get('iac/:version/download')
  async downloadIac(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const { filename, buffer } = await this.service.iacZip(projectId, user, version);
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': buffer.length });
    res.send(buffer);
  }

  // ---- Phase 5 - Validate & approve ----

  /** What-if for one environment of the latest bundle (offline plan, pasted ARM what-if, or live with the Azure sign-in), with its validation report. */
  @Post('what-ifs')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  runWhatIf(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: RunWhatIfDto, @Headers(AZURE_TOKEN_HEADER) token: string | undefined) {
    return this.service.runWhatIf(projectId, user, dto, token);
  }

  @Get('what-ifs')
  whatIfs(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.whatIfHistory(projectId, user);
  }

  /** Approve or reject one environment of the latest bundle; immutable and bound to the bundle hash. */
  @Post('approvals')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  decide(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateApprovalDto) {
    return this.service.decide(projectId, user, dto);
  }

  @Get('approvals')
  approvals(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.approvalHistory(projectId, user);
  }

  // ---- Phase 6 - Deploy ----

  /** Deploys one environment of the latest approved bundle as an Azure Deployment Stack (live what-if approval required). */
  @Post('deployments')
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  deploy(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser, @Headers(AZURE_TOKEN_HEADER) token: string | undefined, @Body() dto: CreateDeploymentDto) {
    return this.service.deploy(projectId, user, token, dto);
  }

  @Get('deployments')
  deployments(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.deploymentHistory(projectId, user);
  }

  /** Reads a running deployment's status from Azure with the caller's sign-in and records it. */
  @Post('deployments/:deploymentId/refresh')
  @HttpCode(200)
  refreshDeployment(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('deploymentId', ParseUUIDPipe) deploymentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Headers(AZURE_TOKEN_HEADER) token: string | undefined,
  ) {
    return this.service.refreshDeployment(projectId, user, token, deploymentId);
  }

  // ---- Phase 7 - Operate (Azure sign-in in the X-Azure-Token header) ----

  /** Smoke tests from what Azure reports about the stack's resources. */
  @Post('deployments/:deploymentId/smoke-tests')
  @HttpCode(200)
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  smokeTests(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('deploymentId', ParseUUIDPipe) deploymentId: string, @CurrentUser() user: AuthenticatedUser, @Headers(AZURE_TOKEN_HEADER) token: string | undefined) {
    return this.service.runSmokeTests(projectId, user, token, deploymentId);
  }

  /** Live what-if of the deployed bundle: anything but NoChange is drift. */
  @Post('deployments/:deploymentId/drift')
  @HttpCode(200)
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  drift(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('deploymentId', ParseUUIDPipe) deploymentId: string, @CurrentUser() user: AuthenticatedUser, @Headers(AZURE_TOKEN_HEADER) token: string | undefined) {
    return this.service.runDriftCheck(projectId, user, token, deploymentId);
  }

  /** Monthly cost budget on the resource group with alerts at 80% and 100%. */
  @Post('deployments/:deploymentId/budget')
  @HttpCode(200)
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  budget(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('deploymentId', ParseUUIDPipe) deploymentId: string, @CurrentUser() user: AuthenticatedUser, @Headers(AZURE_TOKEN_HEADER) token: string | undefined, @Body() dto: SetBudgetDto) {
    return this.service.setBudget(projectId, user, token, deploymentId, dto);
  }

  /** Deletes the stack, every resource it manages, and its budget. Confirmed by typing the environment. */
  @Post('deployments/:deploymentId/teardown')
  @HttpCode(200)
  @Roles(UserRole.ADMIN, UserRole.ARCHITECT)
  teardown(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('deploymentId', ParseUUIDPipe) deploymentId: string, @CurrentUser() user: AuthenticatedUser, @Headers(AZURE_TOKEN_HEADER) token: string | undefined, @Body() dto: TeardownDto) {
    return this.service.teardown(projectId, user, token, deploymentId, dto);
  }

  @Get('operate-checks')
  operateChecks(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.operateHistory(projectId, user);
  }
}
