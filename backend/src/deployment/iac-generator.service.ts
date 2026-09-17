import { Injectable } from '@nestjs/common';
import {
  EMBEDDED_LIBRARY_PLATFORMS,
  FULLY_MANAGED_SAAS_PLATFORMS,
  K8S_SELF_HOSTABLE_PLATFORMS,
  SQL_BASED_PLATFORMS,
  VectorPlatform,
} from '../projects/enums/platform.enum';
import { sanitizeSqlIdentifier } from '../common/identifier-sanitizer';
import { HealthCheckDefinition, KubernetesArtifacts } from './iac-generator.types';

/**
 * Phase 4 requirement: "Use Terraform, Kubernetes YAML/Helm, and SQL where
 * appropriate." SQL comes from SchemaGeneratorService; this service produces
 * the Terraform, Kubernetes/Helm, health-check, checklist, and rollback
 * artifacts for every supported platform, grouped by deployment shape:
 * SQL-based managed instance (Oracle/Postgres/Actian), self-hosted-on-K8s
 * (Milvus/Qdrant/Weaviate/Elasticsearch/Redis), fully-managed SaaS
 * (Pinecone/MongoDB Atlas), and embedded/serverless libraries (Chroma/LanceDB).
 *
 * All of this is a clearly-labeled STARTING POINT - cloud provider, region,
 * sizing, and networking are customer-specific and must be filled in before
 * `terraform apply`/`helm install` is run against anything real. Nothing here
 * executes infrastructure changes; it only generates text for a human (or a
 * subsequent, explicitly-confirmed step) to apply.
 */
@Injectable()
export class IacGeneratorService {
  generateTerraform(platform: VectorPlatform, projectName: string): string {
    const name = sanitizeSqlIdentifier(projectName, 'projectName');
    switch (platform) {
      case VectorPlatform.ORACLE:
        return this.oracleTerraform(name);
      case VectorPlatform.POSTGRES_PGVECTOR:
        return this.postgresTerraform(name);
      case VectorPlatform.ACTIAN:
        return this.actianTerraform(name);
      case VectorPlatform.PINECONE:
        return this.pineconeTerraform(name);
      case VectorPlatform.MONGODB_ATLAS:
        return this.mongoAtlasTerraform(name);
      case VectorPlatform.CHROMA:
        return this.chromaTerraform(name);
      case VectorPlatform.LANCEDB:
        return this.lanceDbTerraform(name);
      default:
        // K8S_SELF_HOSTABLE_PLATFORMS (Milvus/Qdrant/Weaviate/Elasticsearch/Redis)
        return this.k8sClusterTerraform(platform, name);
    }
  }

  private oracleTerraform(name: string): string {
    return [
      '# STARTING POINT - fill in compartment/network/sizing for your OCI tenancy before applying.',
      `resource "oci_database_autonomous_database" "${name}" {`,
      `  compartment_id           = var.compartment_id`,
      `  db_name                  = "${name}"`,
      `  display_name             = "${name}"`,
      `  db_workload              = "OLTP"`,
      `  is_free_tier             = false`,
      `  cpu_core_count           = var.oracle_cpu_core_count`,
      `  data_storage_size_in_tbs = var.oracle_storage_tbs`,
      `  admin_password           = var.oracle_admin_password # supply via TF_VAR_/secret manager - never commit`,
      `  license_model            = "LICENSE_INCLUDED"`,
      '}',
      '',
      'variable "compartment_id" {',
      '  type = string',
      '}',
      'variable "oracle_cpu_core_count" {',
      '  type    = number',
      '  default = 2',
      '}',
      'variable "oracle_storage_tbs" {',
      '  type    = number',
      '  default = 1',
      '}',
      'variable "oracle_admin_password" {',
      '  type      = string',
      '  sensitive = true',
      '}',
    ].join('\n');
  }

  private postgresTerraform(name: string): string {
    return [
      '# STARTING POINT - fill in VPC/subnet/sizing for your AWS account before applying.',
      `resource "aws_db_instance" "${name}" {`,
      `  identifier              = "${name}"`,
      `  engine                  = "postgres"`,
      `  engine_version          = var.postgres_engine_version # must be >= 15 for current pgvector`,
      `  instance_class          = var.instance_class`,
      `  allocated_storage       = var.allocated_storage_gb`,
      `  username                = "vector_admin"`,
      `  password                = var.db_admin_password # supply via TF_VAR_/secret manager - never commit`,
      `  db_subnet_group_name    = var.db_subnet_group_name`,
      `  vpc_security_group_ids  = var.vpc_security_group_ids`,
      `  skip_final_snapshot     = false`,
      `  final_snapshot_identifier = "${name}-final"`,
      '}',
      '',
      'variable "postgres_engine_version" {',
      '  type    = string',
      '  default = "16.4"',
      '}',
      'variable "instance_class" {',
      '  type    = string',
      '  default = "db.r6g.large"',
      '}',
      'variable "allocated_storage_gb" {',
      '  type    = number',
      '  default = 100',
      '}',
      'variable "db_admin_password" {',
      '  type      = string',
      '  sensitive = true',
      '}',
      'variable "db_subnet_group_name" {',
      '  type = string',
      '}',
      'variable "vpc_security_group_ids" {',
      '  type = list(string)',
      '}',
      '',
      '# Run once connected: CREATE EXTENSION IF NOT EXISTS vector; (see the generated SQL script).',
    ].join('\n');
  }

  private actianTerraform(name: string): string {
    return [
      '# No official Actian Terraform provider exists as of this writing - provisioning is manual.',
      `# Manual steps for "${name}":`,
      '#   1. Provision an Actian Data Platform / Actian Vector instance (Actian Cloud console, or an on-prem installer).',
      '#   2. Configure network access (VPN/firewall) from wherever this tool\'s ingestion adapter will run.',
      '#   3. Create the database and an application login; store its ODBC connection string in your secret manager.',
      '#   4. Apply the generated SQL script (see Phase 2/Phase 3 output) via isql, DBeaver, or another SQL client.',
      '# Track these steps with a `null_resource` + local-exec/manual-approval step in your own Terraform if you need',
      '# this recorded in state; there is nothing this tool can safely automate without a real provider to target.',
    ].join('\n');
  }

  private pineconeTerraform(name: string): string {
    return [
      '# STARTING POINT - uses the official pinecone-io/pinecone Terraform provider.',
      '# https://registry.terraform.io/providers/pinecone-io/pinecone/latest/docs',
      'terraform {',
      '  required_providers {',
      '    pinecone = {',
      '      source = "pinecone-io/pinecone"',
      '    }',
      '  }',
      '}',
      '',
      'provider "pinecone" {',
      '  api_key = var.pinecone_api_key # supply via TF_VAR_/secret manager - never commit',
      '}',
      '',
      `resource "pinecone_index" "${name}" {`,
      `  name      = "${name}"`,
      '  dimension = var.embedding_dimension # from the Phase 2 Data & Embedding Design',
      '  metric    = "cosine"',
      '  spec = {',
      '    serverless = {',
      '      cloud  = var.pinecone_cloud',
      '      region = var.pinecone_region',
      '    }',
      '  }',
      '}',
      '',
      'variable "pinecone_api_key" {',
      '  type      = string',
      '  sensitive = true',
      '}',
      'variable "embedding_dimension" {',
      '  type = number',
      '}',
      'variable "pinecone_cloud" {',
      '  type    = string',
      '  default = "aws"',
      '}',
      'variable "pinecone_region" {',
      '  type    = string',
      '  default = "us-east-1"',
      '}',
    ].join('\n');
  }

  private mongoAtlasTerraform(name: string): string {
    return [
      '# STARTING POINT - uses the official mongodb/mongodbatlas Terraform provider.',
      '# https://registry.terraform.io/providers/mongodb/mongodbatlas/latest/docs',
      'terraform {',
      '  required_providers {',
      '    mongodbatlas = {',
      '      source = "mongodb/mongodbatlas"',
      '    }',
      '  }',
      '}',
      '',
      `resource "mongodbatlas_cluster" "${name}" {`,
      '  project_id                 = var.atlas_project_id',
      `  name                       = "${name}"`,
      '  provider_name               = "TENANT"',
      '  backing_provider_name       = var.atlas_backing_provider',
      '  provider_region_name        = var.atlas_region',
      '  provider_instance_size_name = var.atlas_instance_size',
      '}',
      '',
      '# Vector Search index (requires MongoDB 7.0+/Atlas Vector Search) - see the Phase 2 search-index definition JSON.',
      `resource "mongodbatlas_search_index" "${name}_vector" {`,
      '  project_id   = var.atlas_project_id',
      `  cluster_name = mongodbatlas_cluster.${name}.name`,
      '  collection_name = var.collection_name',
      '  database        = var.database_name',
      '  type            = "vectorSearch"',
      '  # fields = jsondecode(file("./vector-search-index.json")).definition.fields  # from the Phase 2 generated schema',
      '}',
      '',
      'variable "atlas_project_id" {',
      '  type = string',
      '}',
      'variable "atlas_backing_provider" {',
      '  type    = string',
      '  default = "AWS"',
      '}',
      'variable "atlas_region" {',
      '  type    = string',
      '  default = "US_EAST_1"',
      '}',
      'variable "atlas_instance_size" {',
      '  type    = string',
      '  default = "M10"',
      '}',
      'variable "collection_name" {',
      '  type = string',
      '}',
      'variable "database_name" {',
      '  type = string',
      '}',
    ].join('\n');
  }

  private chromaTerraform(name: string): string {
    return [
      '# STARTING POINT - Chroma is lightweight enough to self-host as a single container rather than a full cluster.',
      '# Adjust the container image/region/sizing for your GCP project before applying.',
      `resource "google_cloud_run_v2_service" "${name}_chroma" {`,
      `  name     = "${name}-chroma"`,
      '  location = var.gcp_region',
      '',
      '  template {',
      '    containers {',
      '      image = "chromadb/chroma:latest"',
      '      ports {',
      '        container_port = 8000',
      '      }',
      '      volume_mounts {',
      '        name       = "chroma-data"',
      '        mount_path = "/chroma/chroma"',
      '      }',
      '    }',
      '    volumes {',
      '      name = "chroma-data"',
      '      gcs {',
      '        bucket = google_storage_bucket.chroma_data.name',
      '      }',
      '    }',
      '  }',
      '}',
      '',
      `resource "google_storage_bucket" "chroma_data" {`,
      `  name     = "${name}-chroma-data"`,
      '  location = var.gcp_region',
      '}',
      '',
      'variable "gcp_region" {',
      '  type    = string',
      '  default = "us-central1"',
      '}',
      '',
      '# Chroma has no built-in authentication by default - put it behind an internal load balancer / VPC-only ingress,',
      '# or set CHROMA_SERVER_AUTH_PROVIDER before exposing it beyond a trusted network.',
    ].join('\n');
  }

  private lanceDbTerraform(name: string): string {
    return [
      '# STARTING POINT - LanceDB is an embedded library, not a server: the app process reads/writes its dataset',
      '# directly, so the only real infrastructure is the object storage bucket backing it.',
      `resource "aws_s3_bucket" "${name}_lancedb" {`,
      `  bucket = "${name}-lancedb-data"`,
      '}',
      '',
      `resource "aws_s3_bucket_versioning" "${name}_lancedb" {`,
      `  bucket = aws_s3_bucket.${name}_lancedb.id`,
      '  versioning_configuration {',
      '    status = "Enabled"',
      '  }',
      '}',
      '',
      '# Grant the application role read/write access to this bucket (IAM policy, not shown) - that role\'s',
      '# credentials are how the LanceDB client authenticates; there is no separate database server or user to manage.',
    ].join('\n');
  }

  private readonly k8sClusterMeta: Partial<Record<VectorPlatform, { label: string; nodePoolName: string }>> = {
    [VectorPlatform.MILVUS]: { label: 'milvus', nodePoolName: 'milvus-pool' },
    [VectorPlatform.QDRANT]: { label: 'qdrant', nodePoolName: 'qdrant-pool' },
    [VectorPlatform.WEAVIATE]: { label: 'weaviate', nodePoolName: 'weaviate-pool' },
    [VectorPlatform.ELASTICSEARCH]: { label: 'elasticsearch', nodePoolName: 'es-pool' },
    [VectorPlatform.REDIS]: { label: 'redis', nodePoolName: 'redis-pool' },
  };

  private k8sClusterTerraform(platform: VectorPlatform, name: string): string {
    const meta = this.k8sClusterMeta[platform] ?? { label: platform, nodePoolName: `${platform}-pool` };
    return [
      `# STARTING POINT - provisions the Kubernetes cluster ${meta.label} will run on.`,
      '# Fill in node sizing/count and networking for your cloud provider before applying.',
      `resource "google_container_cluster" "${name}" {`,
      `  name     = "${name}-${meta.label}"`,
      `  location = var.gcp_region`,
      '',
      `  node_pool {`,
      `    name       = "${meta.nodePoolName}"`,
      `    node_count = var.node_count`,
      `    node_config {`,
      `      machine_type = var.machine_type`,
      `    }`,
      `  }`,
      '}',
      '',
      'variable "gcp_region" {',
      '  type = string',
      '}',
      'variable "node_count" {',
      '  type    = number',
      '  default = 3',
      '}',
      'variable "machine_type" {',
      '  type    = string',
      '  default = "e2-standard-8"',
      '}',
      '',
      `# Deploy ${meta.label} itself onto this cluster with Helm/K8s YAML - see the generated Kubernetes artifacts.`,
    ].join('\n');
  }

  generateKubernetesArtifacts(platform: VectorPlatform, collectionName: string): KubernetesArtifacts {
    switch (platform) {
      case VectorPlatform.QDRANT:
        return this.qdrantKubernetesArtifacts(collectionName);
      case VectorPlatform.WEAVIATE:
        return this.weaviateKubernetesArtifacts(collectionName);
      case VectorPlatform.ELASTICSEARCH:
        return this.elasticsearchKubernetesArtifacts(collectionName);
      case VectorPlatform.REDIS:
        return this.redisKubernetesArtifacts(collectionName);
      default:
        return this.milvusKubernetesArtifacts(collectionName);
    }
  }

  private namespaceFor(collectionName: string, suffix: string): { namespace: string; namespaceYaml: string } {
    const namespace = sanitizeSqlIdentifier(`${collectionName}-${suffix}`, 'collectionName');
    const namespaceYaml = ['apiVersion: v1', 'kind: Namespace', 'metadata:', `  name: ${namespace}`].join('\n');
    return { namespace, namespaceYaml };
  }

  private milvusKubernetesArtifacts(collectionName: string): KubernetesArtifacts {
    const { namespace, namespaceYaml } = this.namespaceFor(collectionName, 'milvus');

    const secretYaml = [
      'apiVersion: v1',
      'kind: Secret',
      'metadata:',
      `  name: milvus-credentials`,
      `  namespace: ${namespace}`,
      'type: Opaque',
      'stringData:',
      '  # Never commit real values - populate via `kubectl create secret` or a secrets manager (e.g. External Secrets Operator).',
      '  MINIO_ACCESS_KEY: "REPLACE_ME"',
      '  MINIO_SECRET_KEY: "REPLACE_ME"',
    ].join('\n');

    const helmValuesYaml = [
      '# Values for the official `milvus/milvus` Helm chart (helm repo add milvus https://zilliztech.github.io/milvus-helm/).',
      `# helm install ${namespace} milvus/milvus -n ${namespace} -f these-values.yaml`,
      'cluster:',
      '  enabled: true',
      'etcd:',
      '  replicaCount: 3',
      '  persistence:',
      '    enabled: true',
      '    size: 10Gi',
      'minio:',
      '  mode: distributed',
      '  persistence:',
      '    enabled: true',
      '    size: 100Gi',
      '  existingSecret: milvus-credentials',
      'pulsar:',
      '  enabled: true',
      'queryNode:',
      '  replicas: 2',
      'dataNode:',
      '  replicas: 2',
      'indexNode:',
      '  replicas: 2',
      'proxy:',
      '  replicas: 2',
      'metrics:',
      '  enabled: true',
      '  serviceMonitor:',
      '    enabled: true # scraped by Prometheus - see the health check / monitoring notes',
    ].join('\n');

    return {
      namespaceYaml,
      secretYaml,
      helmValuesYaml,
      notes: [
        'Query/data/index node and proxy replica counts are starting points - size per the Phase 3 index choice and expected QPS, then revisit in Phase 7 (Scaling & Sharding).',
        'Persistent volume sizes must exceed the Phase 3 Indexing Strategy Guide’s estimated memory/storage footprint with headroom for growth.',
      ],
    };
  }

  private qdrantKubernetesArtifacts(collectionName: string): KubernetesArtifacts {
    const { namespace, namespaceYaml } = this.namespaceFor(collectionName, 'qdrant');
    const secretYaml = [
      'apiVersion: v1',
      'kind: Secret',
      'metadata:',
      '  name: qdrant-api-key',
      `  namespace: ${namespace}`,
      'type: Opaque',
      'stringData:',
      '  # Never commit real values - populate via `kubectl create secret` or a secrets manager.',
      '  QDRANT__SERVICE__API_KEY: "REPLACE_ME"',
    ].join('\n');
    const helmValuesYaml = [
      '# Values for the official `qdrant/qdrant` Helm chart (helm repo add qdrant https://qdrant.github.io/qdrant-helm).',
      `# helm install ${namespace} qdrant/qdrant -n ${namespace} -f these-values.yaml`,
      'replicaCount: 3',
      'persistence:',
      '  size: 50Gi',
      'apiKey:',
      '  existingSecret: qdrant-api-key',
      '  existingSecretKey: QDRANT__SERVICE__API_KEY',
      'service:',
      '  type: ClusterIP',
    ].join('\n');
    return {
      namespaceYaml,
      secretYaml,
      helmValuesYaml,
      notes: [
        'replicaCount and persistence size are starting points - size per the Phase 3 index choice and expected vector count/QPS.',
        'Qdrant shards collections automatically across replicas when created with shard_number > 1 - set that at collection-creation time (Phase 2 schema), not here.',
      ],
    };
  }

  private weaviateKubernetesArtifacts(collectionName: string): KubernetesArtifacts {
    const { namespace, namespaceYaml } = this.namespaceFor(collectionName, 'weaviate');
    const secretYaml = [
      'apiVersion: v1',
      'kind: Secret',
      'metadata:',
      '  name: weaviate-auth',
      `  namespace: ${namespace}`,
      'type: Opaque',
      'stringData:',
      '  # Never commit real values - populate via `kubectl create secret` or a secrets manager.',
      '  AUTHENTICATION_APIKEY_ALLOWED_KEYS: "REPLACE_ME"',
    ].join('\n');
    const helmValuesYaml = [
      '# Values for the official `weaviate/weaviate` Helm chart (helm repo add weaviate https://weaviate.github.io/weaviate-helm).',
      `# helm install ${namespace} weaviate/weaviate -n ${namespace} -f these-values.yaml`,
      'replicas: 3',
      'storage:',
      '  size: 50Gi',
      'authentication:',
      '  apikey:',
      '    enabled: true',
      '    existingSecret: weaviate-auth',
      'modules:',
      '  default_vectorizer_module: none # embeddings come from this platform\'s Phase 2 embedding model choice',
    ].join('\n');
    return {
      namespaceYaml,
      secretYaml,
      helmValuesYaml,
      notes: [
        'replicas and storage size are starting points - size per the Phase 3 index choice and expected vector count/QPS.',
        'default_vectorizer_module is "none" because this platform supplies vectors at upsert time rather than having Weaviate compute them.',
      ],
    };
  }

  private elasticsearchKubernetesArtifacts(collectionName: string): KubernetesArtifacts {
    const { namespace, namespaceYaml } = this.namespaceFor(collectionName, 'es');
    const secretYaml = [
      'apiVersion: v1',
      'kind: Secret',
      'metadata:',
      '  name: es-elastic-user',
      `  namespace: ${namespace}`,
      'type: Opaque',
      'stringData:',
      '  # Never commit real values - the ECK operator can also auto-generate and store this secret itself.',
      '  elastic: "REPLACE_ME"',
    ].join('\n');
    const helmValuesYaml = [
      '# Uses the official Elastic Cloud on Kubernetes (ECK) operator, not a plain Elasticsearch Helm chart.',
      '# helm repo add elastic https://helm.elastic.co && helm install elastic-operator elastic/eck-operator -n elastic-system --create-namespace',
      '# Then apply this Elasticsearch custom resource (not a values.yaml):',
      'apiVersion: elasticsearch.k8s.elastic.co/v1',
      'kind: Elasticsearch',
      'metadata:',
      `  name: ${namespace}`,
      `  namespace: ${namespace}`,
      'spec:',
      '  version: 8.15.0',
      '  nodeSets:',
      '    - name: default',
      '      count: 3',
      '      volumeClaimTemplates:',
      '        - metadata:',
      '            name: elasticsearch-data',
      '          spec:',
      '            accessModes: [ReadWriteOnce]',
      '            resources:',
      '              requests:',
      '                storage: 100Gi',
    ].join('\n');
    return {
      namespaceYaml,
      secretYaml,
      helmValuesYaml,
      notes: [
        'node count and storage size are starting points - size per the Phase 3 index choice and expected vector count/QPS.',
        'AWS OpenSearch Service (a managed alternative to self-hosting) is generally simpler to operate than self-hosted ECK, at the cost of the k-NN plugin\'s API differing slightly from Elasticsearch\'s dense_vector.',
      ],
    };
  }

  private redisKubernetesArtifacts(collectionName: string): KubernetesArtifacts {
    const { namespace, namespaceYaml } = this.namespaceFor(collectionName, 'redis');
    const secretYaml = [
      'apiVersion: v1',
      'kind: Secret',
      'metadata:',
      '  name: redis-credentials',
      `  namespace: ${namespace}`,
      'type: Opaque',
      'stringData:',
      '  # Never commit real values - populate via `kubectl create secret` or a secrets manager.',
      '  REDIS_PASSWORD: "REPLACE_ME"',
    ].join('\n');
    const helmValuesYaml = [
      '# Standard managed Redis (e.g. AWS ElastiCache) does NOT support vector search - this uses the Bitnami `redis`',
      '# chart with the image overridden to `redis-stack-server`, which bundles the RediSearch module.',
      '# helm repo add bitnami https://charts.bitnami.com/bitnami && helm install ' + namespace + ' bitnami/redis -n ' + namespace + ' -f these-values.yaml',
      'image:',
      '  repository: redis/redis-stack-server',
      '  tag: latest',
      'auth:',
      '  existingSecret: redis-credentials',
      '  existingSecretPasswordKey: REDIS_PASSWORD',
      'master:',
      '  persistence:',
      '    size: 20Gi',
      'replica:',
      '  replicaCount: 2',
      '  persistence:',
      '    size: 20Gi',
    ].join('\n');
    return {
      namespaceYaml,
      secretYaml,
      helmValuesYaml,
      notes: [
        'Plain open-source Redis and standard managed Redis (AWS ElastiCache, etc.) do not support vector search - only Redis Stack (self-hosted, shown here) or Redis Enterprise Cloud (fully managed) include the RediSearch module.',
        'replica count and persistence size are starting points - size per the Phase 3 index choice and expected vector count/QPS.',
      ],
    };
  }

  getHealthCheckDefinition(platform: VectorPlatform): HealthCheckDefinition {
    switch (platform) {
      case VectorPlatform.ORACLE:
        return { description: 'Execute a trivial query against the target Oracle instance.', check: 'SELECT 1 FROM DUAL' };
      case VectorPlatform.POSTGRES_PGVECTOR:
        return { description: 'Execute a trivial query against the target PostgreSQL instance.', check: 'SELECT 1' };
      case VectorPlatform.ACTIAN:
        return { description: 'Execute a trivial query against the target Actian instance via an ODBC bridge.', check: 'SELECT 1' };
      case VectorPlatform.MILVUS:
        return { description: 'Call the Milvus gRPC health check endpoint and confirm isHealthy is true.', check: 'MilvusClient.checkHealth()' };
      case VectorPlatform.QDRANT:
        return { description: 'Call Qdrant\'s health endpoint and confirm a 200 response.', check: 'GET /healthz' };
      case VectorPlatform.WEAVIATE:
        return { description: 'Call Weaviate\'s readiness endpoint and confirm a 200 response.', check: 'GET /v1/.well-known/ready' };
      case VectorPlatform.CHROMA:
        return { description: 'Call Chroma\'s heartbeat endpoint and confirm a 200 response.', check: 'GET /api/v1/heartbeat' };
      case VectorPlatform.ELASTICSEARCH:
        return { description: 'Call the cluster health endpoint and confirm status is not red.', check: 'GET /_cluster/health' };
      case VectorPlatform.REDIS:
        return { description: 'Send a PING and confirm a PONG response.', check: 'PING' };
      case VectorPlatform.MONGODB_ATLAS:
        return { description: 'Run the standard MongoDB ping command against the target cluster.', check: "db.runCommand({ ping: 1 })" };
      case VectorPlatform.LANCEDB:
        return {
          description: 'Confirm the configured storage URI (local path or S3/GCS bucket) is reachable and writable - LanceDB is embedded, so there is no server process to ping.',
          check: 'openOrCreateTable(uri)',
        };
      case VectorPlatform.PINECONE:
        return { description: 'Call describeIndexStats on the target index and confirm it responds.', check: 'index.describeIndexStats()' };
      default:
        return { description: 'No health check is defined for this platform.', check: 'n/a' };
    }
  }

  getRollbackProcedure(platform: VectorPlatform): string[] {
    const shared = [
      'Never run a destructive rollback step (dropping a table/collection, deleting a cluster) without explicit, out-of-band confirmation - the adapter layer refuses drop operations unless confirm=true is passed deliberately.',
      'Prefer disabling traffic to the new schema/collection (feature flag or app-config rollback) over deleting data, so the failed deployment can be inspected afterward.',
    ];
    if (platform === VectorPlatform.ORACLE) {
      return [...shared, 'Restore the Autonomous Database from its automatic backup to the timestamp immediately before this deployment.', 'If only the vector index is at fault, DROP the index (not the table) and re-run Phase 3 tuning before recreating it.'];
    }
    if (platform === VectorPlatform.POSTGRES_PGVECTOR) {
      return [...shared, 'Restore the RDS/Cloud SQL instance from its automatic snapshot to the timestamp immediately before this deployment.', 'If only the vector index is at fault, DROP INDEX (not the table) and re-run Phase 3 tuning before recreating it.'];
    }
    if (platform === VectorPlatform.ACTIAN) {
      return [...shared, 'Restore from your Actian instance\'s own backup/checkpoint mechanism to the timestamp immediately before this deployment.', 'If only the vector index is at fault, drop and recreate just the index rather than the table.'];
    }
    if (K8S_SELF_HOSTABLE_PLATFORMS.includes(platform)) {
      return [
        ...shared,
        'Roll back with `helm rollback <release> <previous-revision>` rather than deleting the namespace.',
        'If only the collection’s/index\'s configuration is at fault, drop and recreate just the index rather than the collection.',
      ];
    }
    if (FULLY_MANAGED_SAAS_PLATFORMS.includes(platform)) {
      return [
        ...shared,
        'Recreate the index/cluster from the reviewed Terraform rather than hand-editing it in the vendor console, so state stays reconciled.',
        'If only the index configuration is at fault, delete and recreate just the index (most managed vector services do not support in-place algorithm changes) rather than the whole project/cluster.',
      ];
    }
    if (platform === VectorPlatform.CHROMA) {
      return [...shared, 'Redeploy the previous container revision (Cloud Run keeps prior revisions) rather than deleting the data volume/bucket.', 'If only the collection is at fault, delete and recreate just that collection via the client library.'];
    }
    // LanceDB
    return [...shared, 'Restore the object storage bucket/path from its own versioning (e.g. S3 bucket versioning) to before this deployment.', 'If only the table is at fault, drop and recreate just that table rather than the whole dataset directory.'];
  }

  getDeploymentChecklist(platform: VectorPlatform): string[] {
    const shared = [
      'Confirm TARGET_* connection environment variables are set via a secret manager, never committed to source control.',
      'Verify network connectivity (VPC peering / security group / firewall rule, or API reachability for a SaaS platform) from the application to the target database.',
      'Run the health check below and confirm it passes before creating any schema.',
      'Apply the generated schema/config (table + vector index, or collection/index config) exactly as reviewed - do not hand-edit generated identifiers.',
      'Re-run the health check after schema creation to confirm the database is still reachable and responsive.',
      'Record this deployment (version, rules version, timestamp) in the audit trail before marking Phase 4 complete.',
    ];
    if (platform === VectorPlatform.MILVUS) {
      return [
        'Provision the Kubernetes cluster via the generated Terraform (or an existing cluster).',
        'Create the namespace and secrets from the generated Kubernetes YAML.',
        '`helm install` the Milvus chart using the generated values file.',
        'Wait for all Milvus component pods (proxy, query/data/index nodes, etcd, MinIO, Pulsar) to reach Ready.',
        ...shared,
      ];
    }
    if (K8S_SELF_HOSTABLE_PLATFORMS.includes(platform)) {
      return [
        'Provision the Kubernetes cluster via the generated Terraform (or an existing cluster).',
        'Create the namespace and secrets from the generated Kubernetes YAML.',
        '`helm install` (or apply the custom resource, for Elasticsearch/ECK) using the generated values file.',
        'Wait for all pods to reach Ready.',
        ...shared,
      ];
    }
    if (FULLY_MANAGED_SAAS_PLATFORMS.includes(platform)) {
      return ['Provision the index/cluster via the generated Terraform against the vendor\'s API.', ...shared];
    }
    if (EMBEDDED_LIBRARY_PLATFORMS.includes(platform)) {
      return platform === VectorPlatform.CHROMA
        ? ['Provision the container service and its backing storage bucket via the generated Terraform.', ...shared]
        : ['Provision the backing object storage bucket via the generated Terraform - there is no separate server to deploy.', ...shared];
    }
    if (platform === VectorPlatform.ACTIAN) {
      return ['Provision the Actian instance manually (see the Terraform output notes) - no automated provider exists.', ...shared];
    }
    return ['Provision the database instance via the generated Terraform.', ...shared];
  }
}
