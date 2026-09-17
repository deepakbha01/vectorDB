import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CapacityPlan } from './capacity-plan.entity';
import { CapacityPlanningService } from './capacity-planning.service';
import { CapacityPlanningController } from './capacity-planning.controller';
import { CapacityForecastEngineModule } from './capacity-forecast-engine.module';
import { ProjectsModule } from '../projects/projects.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { IndexDesignModule } from '../index-design/index-design.module';

@Module({
  imports: [TypeOrmModule.forFeature([CapacityPlan]), CapacityForecastEngineModule, ProjectsModule, DiscoveryModule, IndexDesignModule],
  providers: [CapacityPlanningService],
  controllers: [CapacityPlanningController],
  exports: [CapacityPlanningService],
})
export class CapacityPlanningModule {}
