import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscoveryAssessment } from './discovery-assessment.entity';
import { DiscoveryService } from './discovery.service';
import { DiscoveryController } from './discovery.controller';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [TypeOrmModule.forFeature([DiscoveryAssessment]), ProjectsModule],
  providers: [DiscoveryService],
  controllers: [DiscoveryController],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
