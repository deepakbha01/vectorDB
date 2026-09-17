import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { ProjectsModule } from '../projects/projects.module';
import { DiscoveryModule } from '../discovery/discovery.module';

@Module({
  imports: [ProjectsModule, DiscoveryModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
