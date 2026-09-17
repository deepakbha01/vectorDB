import { Injectable } from '@nestjs/common';
import { PlatformConfigService } from '../common/config/platform-config.service';
import { IndexRecommendationEngineService } from '../index-recommendation-engine/index-recommendation-engine.service';
import {
  EMBEDDED_LIBRARY_PLATFORMS,
  FULLY_MANAGED_SAAS_PLATFORMS,
  K8S_SELF_HOSTABLE_PLATFORMS,
  VectorPlatform,
} from '../projects/enums/platform.enum';
import {
  CapacityForecastInput,
  CapacityForecastResult,
  HorizonForecast,
  ResourceEstimate,
  ShardingRecommendation,
} from './capacity-forecast.types';

/**
 * Phase 7 - Scaling & Sharding capacity forecast engine. Projects vector
 * count and QPS forward from the Discovery assessment's monthly growth rate,
 * re-estimates memory/storage/CPU at each horizon using the same formulas as
 * Phase 1 (infrastructureEstimation) and Phase 3 (IndexRecommendationEngineService.
 * estimateMemoryGb, reused directly - not duplicated), and flags scaling
 * triggers, sharding needs, HA, and DR - all against config/thresholds.yaml,
 * no hard-coded cutoffs.
 */
@Injectable()
export class CapacityForecastEngineService {
  constructor(
    private readonly platformConfig: PlatformConfigService,
    private readonly indexRecommendationEngine: IndexRecommendationEngineService,
  ) {}

  forecast(input: CapacityForecastInput): CapacityForecastResult {
    const thresholds = this.platformConfig.getThresholds();
    const capacityDefaults = thresholds.capacityPlanning;
    const infraEstimation = thresholds.infrastructureEstimation;
    const catalogEntry = this.platformConfig.getIndexCatalog().find((c) => c.id === input.indexType);
    if (!catalogEntry) {
      throw new Error(`Unknown index type '${input.indexType}' - is config/indexes.yaml missing an entry?`);
    }

    const currentState: ResourceEstimate = {
      vectorCount: input.currentVectorCount,
      qps: input.currentQps,
      memoryGb: this.indexRecommendationEngine.estimateMemoryGb(input.indexType, catalogEntry, input.currentVectorCount, input.dimension),
      storageGb: this.estimateStorageGb(input.currentVectorCount, input.dimension, infraEstimation),
      cpuCores: this.estimateCpuCores(input.currentVectorCount, input.currentQps, infraEstimation, capacityDefaults),
    };

    const monthlyGrowthRate = input.monthlyGrowthPercent / 100;
    const forecast: HorizonForecast[] = capacityDefaults.forecastHorizonsMonths.map((months: number) => {
      const growthFactor = (1 + monthlyGrowthRate) ** months;
      const projectedVectorCount = Math.round(input.currentVectorCount * growthFactor);
      const projectedQps = Math.round(input.currentQps * growthFactor);
      const estimatedMemoryGb = this.indexRecommendationEngine.estimateMemoryGb(input.indexType, catalogEntry, projectedVectorCount, input.dimension);
      const estimatedStorageGb = this.estimateStorageGb(projectedVectorCount, input.dimension, infraEstimation);
      const estimatedCpuCores = this.estimateCpuCores(projectedVectorCount, projectedQps, infraEstimation, capacityDefaults);

      return {
        horizonMonths: months,
        projectedVectorCount,
        projectedQps,
        estimatedMemoryGb,
        estimatedStorageGb,
        estimatedCpuCores,
        scalingTriggersHit: this.evaluateTriggers(input, months, estimatedMemoryGb, estimatedCpuCores, estimatedStorageGb, projectedQps, capacityDefaults),
      };
    });

    return {
      currentState,
      forecast,
      shardingRecommendation: this.buildShardingRecommendation(input, forecast, capacityDefaults),
      haRecommendation: this.buildHaRecommendation(input, thresholds),
      drRecommendation: this.buildDrRecommendation(input),
      recommendedInfrastructure: this.buildRecommendedInfrastructure(input, forecast),
    };
  }

  private estimateStorageGb(vectorCount: number, dimension: number, infraEstimation: Record<string, any>): number {
    const rawGb = (vectorCount * dimension * infraEstimation.bytesPerDimension) / 1024 ** 3;
    return Number((rawGb * infraEstimation.indexOverheadFactor * infraEstimation.replicationFactor).toFixed(3));
  }

  private estimateCpuCores(vectorCount: number, qps: number, infraEstimation: Record<string, any>, capacityDefaults: Record<string, any>): number {
    const baseline = (vectorCount / 1_000_000) * infraEstimation.baselineCpuCoresPerMillionVectors;
    const qpsOverhead = (qps / 1000) * capacityDefaults.cpuCoresPerThousandQps;
    return Number(Math.max(2, baseline + qpsOverhead).toFixed(2));
  }

  private evaluateTriggers(
    input: CapacityForecastInput,
    months: number,
    estimatedMemoryGb: number,
    estimatedCpuCores: number,
    estimatedStorageGb: number,
    projectedQps: number,
    capacityDefaults: Record<string, any>,
  ): string[] {
    const triggers = capacityDefaults.scalingTriggers;
    const hit: string[] = [];

    const memoryUtilizationPercent = (estimatedMemoryGb / input.availableMemoryGb) * 100;
    if (memoryUtilizationPercent > triggers.memoryUtilizationPercent) {
      hit.push(`Memory utilization projected at ${memoryUtilizationPercent.toFixed(0)}% of available capacity by month ${months} - plan a memory upgrade.`);
    }

    const cpuUtilizationPercent = (estimatedCpuCores / input.availableCpuCores) * 100;
    if (cpuUtilizationPercent > triggers.cpuUtilizationPercent) {
      hit.push(`CPU utilization projected at ${cpuUtilizationPercent.toFixed(0)}% of available capacity by month ${months} - plan a compute upgrade.`);
    }

    const storageUtilizationPercent = (estimatedStorageGb / input.availableStorageGb) * 100;
    if (storageUtilizationPercent > triggers.storageUtilizationPercent) {
      hit.push(`Storage utilization projected at ${storageUtilizationPercent.toFixed(0)}% of available capacity by month ${months} - plan a storage upgrade.`);
    }

    // QPS has no fixed "available" ceiling like memory/CPU do, so its trigger is expressed as
    // growth relative to today rather than utilization of a resource.
    if (input.currentQps > 0) {
      const qpsGrowthPercent = (projectedQps / input.currentQps) * 100 - 100;
      if (qpsGrowthPercent > triggers.qpsUtilizationPercent) {
        hit.push(`Query throughput projected to grow ${qpsGrowthPercent.toFixed(0)}% by month ${months} - revisit Phase 3 index tuning and connection pooling.`);
      }
    }

    return hit;
  }

  private buildShardingRecommendation(input: CapacityForecastInput, forecast: HorizonForecast[], capacityDefaults: Record<string, any>): ShardingRecommendation {
    const longestHorizon = forecast[forecast.length - 1];

    if (input.platform === VectorPlatform.MILVUS) {
      const milvusDefaults = capacityDefaults.milvus;
      const requiredQueryNodes = Math.max(2, Math.ceil(longestHorizon.projectedVectorCount / milvusDefaults.queryNodeCapacityVectors));
      const requiredDataNodes = Math.max(2, Math.ceil(longestHorizon.projectedVectorCount / milvusDefaults.dataNodeCapacityVectors));
      return {
        strategy: 'Kubernetes horizontal scaling with collection partitioning',
        details: [
          `By month ${longestHorizon.horizonMonths} (~${longestHorizon.projectedVectorCount.toLocaleString()} vectors), plan for ~${requiredQueryNodes} query nodes and ~${requiredDataNodes} data nodes (the Phase 4 Helm baseline ships 2 of each).`,
          'Partition the collection by tenant or ingestion date to keep per-partition search fast and enable targeted re-indexing without a full rebuild.',
          `Configure Kubernetes HPA on the queryNode/dataNode deployments once CPU utilization crosses ${capacityDefaults.scalingTriggers.cpuUtilizationPercent}% (see Phase 4 Helm values).`,
          `A replica factor of ${milvusDefaults.replicaFactorForHa} is recommended so query nodes stay available during maintenance/rolling upgrades.`,
        ],
      };
    }

    if (K8S_SELF_HOSTABLE_PLATFORMS.includes(input.platform)) {
      return this.buildK8sShardingRecommendation(input.platform, longestHorizon, forecast, capacityDefaults);
    }

    if (FULLY_MANAGED_SAAS_PLATFORMS.includes(input.platform)) {
      const advice: Record<string, string> = {
        [VectorPlatform.PINECONE]: 'increase pod replicas (pod-based indexes), or rely on serverless auto-scaling; move to a larger pod type before adding more pods if per-pod utilization is high',
        [VectorPlatform.MONGODB_ATLAS]: 'scale the Atlas cluster tier up (more RAM/CPU) and enable cluster auto-scaling - Vector Search scales with the underlying cluster, not as a separate resource',
      };
      return {
        strategy: 'Vendor-managed scaling (no self-managed sharding)',
        details: [
          `By month ${longestHorizon.horizonMonths} (~${longestHorizon.projectedVectorCount.toLocaleString()} vectors, ~${longestHorizon.projectedQps} QPS), plan to ${advice[input.platform] ?? 'scale up the managed tier'}.`,
          'This platform manages its own internal sharding - there is no self-hosted node pool to size or partition manually.',
          'Confirm the vendor\'s pricing scales acceptably at this projected volume before committing further growth to it.',
        ],
      };
    }

    if (EMBEDDED_LIBRARY_PLATFORMS.includes(input.platform)) {
      return {
        strategy: 'Application-level partitioning (single-node/embedded library)',
        details: [
          `${input.platform} runs in-process with no built-in distributed sharding - by month ${longestHorizon.horizonMonths} ` +
            `(~${longestHorizon.projectedVectorCount.toLocaleString()} vectors), scaling further means partitioning across ` +
            'multiple collections/tables and routing queries at the application layer, or migrating to a dedicated/managed engine (revisit Phase 1).',
          'Vertical scaling (more RAM on the host process) is the only lever available before that migration becomes necessary.',
        ],
      };
    }

    // SQL_BASED_PLATFORMS: Oracle, PostgreSQL + pgvector, Actian.
    const embeddedDefaults = capacityDefaults.embedded;
    const details: string[] = [];
    const needsVerticalLimitWarning = forecast.some((f) => f.estimatedCpuCores > embeddedDefaults.verticalScalingMaxCores);
    const needsReadReplica = forecast.some((f) => f.projectedQps > embeddedDefaults.readReplicaQpsThreshold);
    const needsPartitioning = forecast.some((f) => f.projectedVectorCount > embeddedDefaults.partitioningVectorCountThreshold);

    details.push('Scale vertically (more CPU/RAM) first - it is the simplest lever for a single embedded instance.');
    if (needsReadReplica) {
      const horizon = forecast.find((f) => f.projectedQps > embeddedDefaults.readReplicaQpsThreshold)!;
      details.push(`Sustained QPS is projected to exceed ${embeddedDefaults.readReplicaQpsThreshold} by month ${horizon.horizonMonths} - add read replicas for query traffic rather than continuing to scale up.`);
    }
    if (needsPartitioning) {
      const horizon = forecast.find((f) => f.projectedVectorCount > embeddedDefaults.partitioningVectorCountThreshold)!;
      details.push(`Vector count is projected to exceed ${embeddedDefaults.partitioningVectorCountThreshold.toLocaleString()} by month ${horizon.horizonMonths} - partition the table (by tenant or date range) to keep index maintenance and vacuum/rebuild operations manageable.`);
    }
    if (needsVerticalLimitWarning) {
      const horizon = forecast.find((f) => f.estimatedCpuCores > embeddedDefaults.verticalScalingMaxCores)!;
      details.push(`Projected CPU need exceeds a practical vertical-scaling ceiling (${embeddedDefaults.verticalScalingMaxCores} cores) by month ${horizon.horizonMonths} - re-evaluate a dedicated/managed platform at that point (see Phase 1's Architecture Decision Engine).`);
    }
    const poolingAdvice: Record<string, string> = {
      [VectorPlatform.ORACLE]: 'Use Database Resident Connection Pooling (DRCP) to bound connection overhead as concurrency grows.',
      [VectorPlatform.POSTGRES_PGVECTOR]: 'Use PgBouncer (transaction pooling) to bound connection overhead as concurrency grows.',
      [VectorPlatform.ACTIAN]: 'Use Actian\'s built-in connection pooling (or an external pooler reachable over its ODBC/JDBC interface) to bound connection overhead as concurrency grows.',
    };
    details.push(poolingAdvice[input.platform]);

    return { strategy: 'Vertical scaling, then read replicas, then partitioning', details };
  }

  private buildK8sShardingRecommendation(
    platform: VectorPlatform,
    longestHorizon: HorizonForecast,
    forecast: HorizonForecast[],
    capacityDefaults: Record<string, any>,
  ): ShardingRecommendation {
    const embeddedDefaults = capacityDefaults.embedded;
    const needsMoreReplicas = forecast.some((f) => f.projectedQps > embeddedDefaults.readReplicaQpsThreshold);
    const needsSharding = forecast.some((f) => f.projectedVectorCount > embeddedDefaults.partitioningVectorCountThreshold);

    const advice: Record<string, string> = {
      [VectorPlatform.QDRANT]: 'increase shard_number and replication_factor on the collection, then add nodes to the Kubernetes node pool to host them',
      [VectorPlatform.WEAVIATE]: 'enable sharding (multiple physical shards per class) and increase replicationFactor, then add nodes to the Kubernetes node pool',
      [VectorPlatform.ELASTICSEARCH]: 'increase the index\'s primary shard count (set at index-creation time - reindex to change it) and add data nodes to the ECK-managed node pool',
      [VectorPlatform.REDIS]: 'move to Redis Cluster mode (hash-slot sharding across primaries) and add replica nodes for read scaling',
    };

    const details: string[] = [
      `By month ${longestHorizon.horizonMonths} (~${longestHorizon.projectedVectorCount.toLocaleString()} vectors, ~${longestHorizon.projectedQps} QPS), plan to ${advice[platform] ?? 'scale out the cluster'}.`,
    ];
    if (needsSharding) {
      details.push(`Vector count is projected to exceed ${embeddedDefaults.partitioningVectorCountThreshold.toLocaleString()} vectors - a single-shard deployment will no longer fit comfortably in one node's memory.`);
    }
    if (needsMoreReplicas) {
      details.push(`Query throughput is projected to exceed ${embeddedDefaults.readReplicaQpsThreshold} QPS - add read replicas before this point.`);
    }
    details.push(`Configure Kubernetes HPA on the workload once CPU utilization crosses ${capacityDefaults.scalingTriggers.cpuUtilizationPercent}% (see the Phase 4 Helm values).`);

    return { strategy: 'Kubernetes horizontal scaling with platform-native sharding/replication', details };
  }

  private buildHaRecommendation(input: CapacityForecastInput, thresholds: Record<string, any>): string[] {
    const isHighAvailability = input.availabilityTargetPercent >= thresholds.availability.highAvailabilityThreshold;
    const pct = input.availabilityTargetPercent;

    const highAvailabilityAdvice: Partial<Record<VectorPlatform, string>> = {
      [VectorPlatform.MILVUS]: `Availability target (${pct}%) requires multi-replica query nodes across multiple Kubernetes nodes/zones and etcd/Pulsar quorum spread across zones.`,
      [VectorPlatform.ORACLE]: `Availability target (${pct}%) warrants Oracle Data Guard (physical standby) with fast-start failover.`,
      [VectorPlatform.POSTGRES_PGVECTOR]: `Availability target (${pct}%) warrants a Multi-AZ deployment with automated failover (e.g. RDS/Cloud SQL Multi-AZ).`,
      [VectorPlatform.ACTIAN]: `Availability target (${pct}%) warrants Actian's own HA/replication feature with automated failover, or a hot standby reachable via the same ODBC/JDBC endpoint.`,
      [VectorPlatform.QDRANT]: `Availability target (${pct}%) warrants a multi-node Qdrant cluster with replication_factor >= 2 spread across Kubernetes zones.`,
      [VectorPlatform.WEAVIATE]: `Availability target (${pct}%) warrants replicationFactor >= 2 with nodes spread across Kubernetes zones.`,
      [VectorPlatform.ELASTICSEARCH]: `Availability target (${pct}%) warrants at least one replica shard per index with ECK zone-awareness spreading primaries/replicas across zones.`,
      [VectorPlatform.REDIS]: `Availability target (${pct}%) warrants Redis Cluster or Sentinel with replicas spread across zones - plain single-instance Redis Stack cannot meet this target.`,
      [VectorPlatform.PINECONE]: `Availability target (${pct}%) is met by Pinecone's own multi-AZ-backed infrastructure for serverless indexes; for pod-based indexes, run replica pods across availability zones.`,
      [VectorPlatform.MONGODB_ATLAS]: `Availability target (${pct}%) is met by an Atlas replica set (M10+) spread across multiple availability zones - this is enabled by default on dedicated clusters.`,
      [VectorPlatform.CHROMA]: `Availability target (${pct}%) is ambitious for Chroma, which has no built-in HA - front it with a standby instance and a load balancer that fails over on health-check failure, or reconsider the platform choice for this target (see Phase 1).`,
      [VectorPlatform.LANCEDB]: `Availability target (${pct}%) depends entirely on the backing object storage's own durability/replication (e.g. S3's built-in multi-AZ replication) - LanceDB itself has no server component to make redundant.`,
    };
    const standardAdvice: Partial<Record<VectorPlatform, string>> = {
      [VectorPlatform.MILVUS]: `Availability target (${pct}%) can be met with a single replica per component, provided Kubernetes reschedules failed pods automatically.`,
      [VectorPlatform.CHROMA]: `Availability target (${pct}%) can be met by a single Chroma instance with automated container restarts and periodic backup of its data volume.`,
      [VectorPlatform.LANCEDB]: `Availability target (${pct}%) can be met by the backing object storage's standard durability guarantees plus automated restarts of the application process.`,
      [VectorPlatform.POSTGRES_PGVECTOR]: `Availability target (${pct}%) can be met with automated backups (e.g. RDS/Cloud SQL) and a documented manual failover procedure.`,
      [VectorPlatform.ACTIAN]: `Availability target (${pct}%) can be met with automated backups and a documented manual failover procedure.`,
      [VectorPlatform.QDRANT]: `Availability target (${pct}%) can be met with a single-node deployment plus automated backups, provided Kubernetes reschedules a failed pod automatically.`,
      [VectorPlatform.WEAVIATE]: `Availability target (${pct}%) can be met with replicationFactor: 1 plus automated backups, provided Kubernetes reschedules a failed pod automatically.`,
      [VectorPlatform.ELASTICSEARCH]: `Availability target (${pct}%) can be met with zero replica shards plus automated snapshots, provided the ECK operator reschedules a failed node automatically.`,
      [VectorPlatform.REDIS]: `Availability target (${pct}%) can be met with a single Redis Stack instance plus automated backups (RDB/AOF), provided Kubernetes reschedules a failed pod automatically.`,
      [VectorPlatform.PINECONE]: `Availability target (${pct}%) is comfortably met by Pinecone's own infrastructure even for a single-replica pod-based index.`,
      [VectorPlatform.MONGODB_ATLAS]: `Availability target (${pct}%) can be met by a standard Atlas replica set - even the smallest dedicated tier includes automated failover.`,
    };

    const advice = isHighAvailability ? highAvailabilityAdvice[input.platform] : standardAdvice[input.platform];
    return [advice ?? `Availability target (${pct}%) can be met with automated backups and a documented manual failover procedure.`];
  }

  private buildDrRecommendation(input: CapacityForecastInput): string[] {
    return [
      `Take backups/snapshots at least every ${input.rpoMinutes} minutes to meet the RPO target - confirm the platform's backup mechanism supports that frequency.`,
      `A ${input.rtoMinutes}-minute RTO target requires a tested, scripted restore/failover procedure (see the Phase 4 Deployment Plan's rollback procedure) - not a manual, ad-hoc one.`,
      input.rtoMinutes <= 60
        ? 'A sub-hour RTO typically requires a warm standby (already provisioned, ready to promote) rather than a cold restore from backup.'
        : 'Periodically run a real restore drill - an untested backup is not a disaster recovery plan.',
    ];
  }

  private buildRecommendedInfrastructure(input: CapacityForecastInput, forecast: HorizonForecast[]): string[] {
    const longestHorizon = forecast[forecast.length - 1];
    return [
      `Provision at least ${longestHorizon.estimatedMemoryGb.toFixed(1)}GB RAM, ${longestHorizon.estimatedCpuCores.toFixed(1)} CPU cores, and ${longestHorizon.estimatedStorageGb.toFixed(1)}GB storage to comfortably reach the ${longestHorizon.horizonMonths}-month horizon (~${longestHorizon.projectedVectorCount.toLocaleString()} vectors, ~${longestHorizon.projectedQps} QPS).`,
      'Re-run this Capacity Plan whenever actual growth deviates materially from the forecast, or at least once per forecast horizon.',
    ];
  }
}
