import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscoveryModule } from '../discovery/discovery.module';
import { ProjectsModule } from '../projects/projects.module';
import { AzureBuilderConfigController, AzureBuilderController } from './azure-builder.controller';
import { AzureBuilderEnabledGuard } from './azure-builder-enabled.guard';
import { AzureBuilderService } from './azure-builder.service';
import { AzureConnection } from './azure-connection.entity';
import { AzureEnvironmentProfile } from './azure-environment-profile.entity';
import { AzureUseCase } from './azure-use-case.entity';
import { AzureArchitecture } from './azure-architecture.entity';
import { AzureIacBundle } from './azure-iac-bundle.entity';
import { AzureWhatIf } from './azure-what-if.entity';
import { AzureApproval } from './azure-approval.entity';

/** Azure AI Factory Builder (Wave 1: Connect, Discover; Wave 2: Use case intake; Wave 3: Architect; Wave 4: Generate IaC; Wave 5: Validate & approve; Wave 6a: live Connect and Discover). Behind AZURE_BUILDER_ENABLED. */
@Module({
  imports: [TypeOrmModule.forFeature([AzureConnection, AzureEnvironmentProfile, AzureUseCase, AzureArchitecture, AzureIacBundle, AzureWhatIf, AzureApproval]), ProjectsModule, DiscoveryModule],
  controllers: [AzureBuilderController, AzureBuilderConfigController],
  providers: [AzureBuilderService, AzureBuilderEnabledGuard],
})
export class AzureBuilderModule {}
