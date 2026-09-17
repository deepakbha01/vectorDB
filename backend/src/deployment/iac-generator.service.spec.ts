import { IacGeneratorService } from './iac-generator.service';
import { VectorPlatform } from '../projects/enums/platform.enum';

describe('IacGeneratorService', () => {
  let service: IacGeneratorService;

  beforeEach(() => {
    service = new IacGeneratorService();
  });

  it('generates Oracle Terraform referencing an autonomous database resource', () => {
    const tf = service.generateTerraform(VectorPlatform.ORACLE, 'My Project');
    expect(tf).toContain('resource "oci_database_autonomous_database" "my_project"');
    expect(tf).not.toContain('{ type');
  });

  it('generates Postgres Terraform referencing an RDS instance with a sanitized identifier', () => {
    const tf = service.generateTerraform(VectorPlatform.POSTGRES_PGVECTOR, 'My Project!');
    expect(tf).toContain('resource "aws_db_instance" "my_project_"');
    expect(tf).toContain('engine                  = "postgres"');
  });

  it('generates a GKE cluster resource for Milvus', () => {
    const tf = service.generateTerraform(VectorPlatform.MILVUS, 'my-project');
    expect(tf).toContain('resource "google_container_cluster"');
  });

  it('generates Kubernetes namespace/secret/Helm values for Milvus', () => {
    const artifacts = service.generateKubernetesArtifacts(VectorPlatform.MILVUS, 'Support Docs');
    expect(artifacts.namespaceYaml).toContain('kind: Namespace');
    expect(artifacts.secretYaml).toContain('kind: Secret');
    expect(artifacts.helmValuesYaml).toContain('milvus/milvus');
  });

  it('never embeds a literal secret value in generated Kubernetes YAML', () => {
    const artifacts = service.generateKubernetesArtifacts(VectorPlatform.MILVUS, 'docs');
    expect(artifacts.secretYaml).toContain('REPLACE_ME');
  });

  it('generates a distinct Helm chart reference for each self-hostable platform', () => {
    expect(service.generateKubernetesArtifacts(VectorPlatform.QDRANT, 'docs').helmValuesYaml).toContain('qdrant/qdrant');
    expect(service.generateKubernetesArtifacts(VectorPlatform.WEAVIATE, 'docs').helmValuesYaml).toContain('weaviate/weaviate');
    expect(service.generateKubernetesArtifacts(VectorPlatform.REDIS, 'docs').helmValuesYaml).toContain('redis-stack-server');
    expect(service.generateKubernetesArtifacts(VectorPlatform.ELASTICSEARCH, 'docs').helmValuesYaml).toContain('eck-operator');
  });

  it('generates real Terraform provider resources for fully-managed SaaS platforms', () => {
    expect(service.generateTerraform(VectorPlatform.PINECONE, 'my-project')).toContain('pinecone-io/pinecone');
    expect(service.generateTerraform(VectorPlatform.MONGODB_ATLAS, 'my-project')).toContain('mongodb/mongodbatlas');
  });

  it('generates object-storage-only Terraform for embedded library platforms', () => {
    expect(service.generateTerraform(VectorPlatform.LANCEDB, 'my-project')).toContain('aws_s3_bucket');
    expect(service.generateTerraform(VectorPlatform.CHROMA, 'my-project')).toContain('google_cloud_run_v2_service');
  });

  it('documents Actian has no automated Terraform provider rather than fabricating one', () => {
    const tf = service.generateTerraform(VectorPlatform.ACTIAN, 'my-project');
    expect(tf).toContain('No official Actian Terraform provider exists');
    expect(tf).not.toContain('resource "');
  });

  it('returns a distinct health check per platform', () => {
    expect(service.getHealthCheckDefinition(VectorPlatform.ORACLE).check).toBe('SELECT 1 FROM DUAL');
    expect(service.getHealthCheckDefinition(VectorPlatform.POSTGRES_PGVECTOR).check).toBe('SELECT 1');
    expect(service.getHealthCheckDefinition(VectorPlatform.MILVUS).check).toContain('checkHealth');
  });

  it('every rollback procedure warns against destructive steps without confirmation', () => {
    for (const platform of [VectorPlatform.ORACLE, VectorPlatform.POSTGRES_PGVECTOR, VectorPlatform.MILVUS]) {
      const steps = service.getRollbackProcedure(platform);
      expect(steps.some((s) => s.toLowerCase().includes('confirm'))).toBe(true);
    }
  });

  it('the Milvus deployment checklist provisions the cluster before applying Helm', () => {
    const checklist = service.getDeploymentChecklist(VectorPlatform.MILVUS);
    const clusterStep = checklist.findIndex((s) => s.includes('Kubernetes cluster'));
    const helmStep = checklist.findIndex((s) => s.includes('helm install'));
    expect(clusterStep).toBeGreaterThanOrEqual(0);
    expect(helmStep).toBeGreaterThan(clusterStep);
  });
});
