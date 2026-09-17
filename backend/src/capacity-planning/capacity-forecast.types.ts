import { VectorPlatform } from '../projects/enums/platform.enum';
import { IndexType } from '../index-recommendation-engine/enums/index-type.enum';

export interface CapacityForecastInput {
  currentVectorCount: number;
  currentQps: number;
  dimension: number;
  availableMemoryGb: number;
  availableCpuCores: number;
  availableStorageGb: number;
  monthlyGrowthPercent: number;
  platform: VectorPlatform;
  indexType: IndexType;
  availabilityTargetPercent: number;
  rpoMinutes: number;
  rtoMinutes: number;
}

export interface ResourceEstimate {
  vectorCount: number;
  qps: number;
  memoryGb: number;
  storageGb: number;
  cpuCores: number;
}

export interface HorizonForecast {
  horizonMonths: number;
  projectedVectorCount: number;
  projectedQps: number;
  estimatedMemoryGb: number;
  estimatedStorageGb: number;
  estimatedCpuCores: number;
  scalingTriggersHit: string[];
}

export interface ShardingRecommendation {
  strategy: string;
  details: string[];
}

export interface CapacityForecastResult {
  currentState: ResourceEstimate;
  forecast: HorizonForecast[];
  shardingRecommendation: ShardingRecommendation;
  haRecommendation: string[];
  drRecommendation: string[];
  recommendedInfrastructure: string[];
}
