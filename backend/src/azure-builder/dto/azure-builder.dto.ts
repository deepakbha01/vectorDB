import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsIn, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { AzureRole, DeploymentModel, ProfileSource, ResourceGroupMode } from '../azure-builder.enums';

/** Phase 0 - declare the target scope. No credentials are accepted or stored. */
export class CreateAzureConnectionDto {
  @ApiProperty() @IsUUID() tenantId: string;
  @ApiProperty() @IsUUID() subscriptionId: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(120) subscriptionName?: string;
  @ApiProperty() @Matches(/^[-\w._()]{1,90}$/) @Matches(/[^.]$/, { message: 'resourceGroup cannot end with a period' }) resourceGroup: string;
  @ApiProperty({ enum: ResourceGroupMode }) @IsEnum(ResourceGroupMode) resourceGroupMode: ResourceGroupMode;
  @ApiProperty({ example: 'centralindia' }) @Matches(/^[a-z0-9]{3,40}$/, { message: 'region must be an Azure region name such as centralindia' }) region: string;
  @ApiProperty({ enum: DeploymentModel }) @IsEnum(DeploymentModel) deploymentModel: DeploymentModel;
  @ApiProperty({ enum: AzureRole }) @IsEnum(AzureRole) role: AzureRole;
}

/**
 * Phase 0, live - the target is verified against Azure with the user's sign-in
 * (sent as the X-Azure-Token header, never in the body). Tenant, subscription
 * name and role come from Azure, not from the user.
 */
export class CreateLiveConnectionDto {
  @ApiProperty() @IsUUID() subscriptionId: string;
  @ApiProperty() @Matches(/^[-\w._()]{1,90}$/) @Matches(/[^.]$/, { message: 'resourceGroup cannot end with a period' }) resourceGroup: string;
  @ApiProperty({ enum: ResourceGroupMode }) @IsEnum(ResourceGroupMode) resourceGroupMode: ResourceGroupMode;
  @ApiProperty({ example: 'centralindia' }) @Matches(/^[a-z0-9]{3,40}$/, { message: 'region must be an Azure region name such as centralindia' }) region: string;
  @ApiProperty({ enum: DeploymentModel }) @IsEnum(DeploymentModel) deploymentModel: DeploymentModel;
}

/**
 * Phase 1 - build an Environment Profile. `resourceGraph` is pasted Resource
 * Graph output (array or { data: [...] }); `form` carries policy, quota and
 * overrides (see ProfileFormInput). With `source = sample` both are ignored.
 * Nested contents are validated in the service (validateEnvironmentProfile).
 */
export class CreateEnvironmentProfileDto {
  @ApiProperty({ enum: ProfileSource }) @IsIn(Object.values(ProfileSource)) source: ProfileSource;
  @ApiProperty({ required: false }) @IsOptional() resourceGraph?: unknown;
  /** Policy, quota and overrides - the ProfileFormInput shape in environment-profile.ts. */
  @ApiProperty({ required: false }) @IsOptional() @IsObject() form?: Record<string, unknown>;
}
