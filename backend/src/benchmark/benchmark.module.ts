import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OptimizationReport } from './optimization-report.entity';
import { BenchmarkService } from './benchmark.service';
import { BenchmarkController } from './benchmark.controller';
import { ProjectsModule } from '../projects/projects.module';
import { IndexDesignModule } from '../index-design/index-design.module';
import { IndexRecommendationEngineModule } from '../index-recommendation-engine/index-recommendation-engine.module';
import { DatabaseAdaptersModule } from '../database-adapters/database-adapters.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([OptimizationReport]),
    ProjectsModule,
    IndexDesignModule,
    IndexRecommendationEngineModule,
    DatabaseAdaptersModule,
  ],
  providers: [BenchmarkService],
  controllers: [BenchmarkController],
  exports: [BenchmarkService],
})
export class BenchmarkModule {}
