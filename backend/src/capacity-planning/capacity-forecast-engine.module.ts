import { Module } from '@nestjs/common';
import { CapacityForecastEngineService } from './capacity-forecast-engine.service';
import { IndexRecommendationEngineModule } from '../index-recommendation-engine/index-recommendation-engine.module';

@Module({
  imports: [IndexRecommendationEngineModule],
  providers: [CapacityForecastEngineService],
  exports: [CapacityForecastEngineService],
})
export class CapacityForecastEngineModule {}
