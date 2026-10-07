import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectsModule } from '../projects/projects.module';
import { AzureBuilderController } from './azure-builder.controller';
import { AzureBuilderEnabledGuard } from './azure-builder-enabled.guard';
import { AzureBuilderService } from './azure-builder.service';
import { AzureConnection } from './azure-connection.entity';
import { AzureEnvironmentProfile } from './azure-environment-profile.entity';

/** Azure AI Factory Builder (Wave 1: Phase 0 Connect, Phase 1 Discover). Behind AZURE_BUILDER_ENABLED. */
@Module({
  imports: [TypeOrmModule.forFeature([AzureConnection, AzureEnvironmentProfile]), ProjectsModule],
  controllers: [AzureBuilderController],
  providers: [AzureBuilderService, AzureBuilderEnabledGuard],
})
export class AzureBuilderModule {}
