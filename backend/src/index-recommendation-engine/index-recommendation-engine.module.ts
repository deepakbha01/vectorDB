import { Module } from '@nestjs/common';
import { IndexRecommendationEngineService } from './index-recommendation-engine.service';

@Module({
  providers: [IndexRecommendationEngineService],
  exports: [IndexRecommendationEngineService],
})
export class IndexRecommendationEngineModule {}
