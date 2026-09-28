import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { ProjectsModule } from '../projects/projects.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { VectorDbSelectionModule } from '../vector-db-selection/vector-db-selection.module';
import { BenchmarkModule } from '../benchmark/benchmark.module';
import { CapacityPlanningModule } from '../capacity-planning/capacity-planning.module';

@Module({
  imports: [ProjectsModule, DiscoveryModule, VectorDbSelectionModule, BenchmarkModule, CapacityPlanningModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
