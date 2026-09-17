import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscoveryAssessment } from './discovery-assessment.entity';
import { ArchitectureDecisionRecord } from './architecture-decision-record.entity';
import { DiscoveryService } from './discovery.service';
import { DiscoveryController } from './discovery.controller';
import { ProjectsModule } from '../projects/projects.module';
import { RecommendationEngineModule } from '../recommendation-engine/recommendation-engine.module';

@Module({
  imports: [TypeOrmModule.forFeature([DiscoveryAssessment, ArchitectureDecisionRecord]), ProjectsModule, RecommendationEngineModule],
  providers: [DiscoveryService],
  controllers: [DiscoveryController],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
