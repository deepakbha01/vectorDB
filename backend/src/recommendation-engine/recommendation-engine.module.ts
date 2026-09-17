import { Module } from '@nestjs/common';
import { RecommendationEngineService } from './recommendation-engine.service';

@Module({
  providers: [RecommendationEngineService],
  exports: [RecommendationEngineService],
})
export class RecommendationEngineModule {}
