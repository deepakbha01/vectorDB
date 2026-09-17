import { BadRequestException } from '@nestjs/common';
import { SchemaGeneratorService } from './schema-generator.service';
import { VectorPlatform } from '../projects/enums/platform.enum';
import { IndexType } from '../index-recommendation-engine/enums/index-type.enum';

describe('SchemaGeneratorService', () => {
  let service: SchemaGeneratorService;

  beforeEach(() => {
    service = new SchemaGeneratorService();
  });

  const input = {
    collectionName: 'Support Tickets',
    dimension: 768,
    metadataFields: [
      { name: 'source_url', type: 'string' as const },
      { name: 'published_at', type: 'date' as const },
    ],
  };

  it('generates schemas for all three platforms', () => {
    const result = service.generateAll(input);
    expect(result.oracle.ddl).toContain('VECTOR(768, FLOAT32)');
    expect(result.postgres_pgvector.ddl).toContain('vector(768)');
    expect(result.milvus.schema.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'embedding', dim: 768 })]),
    );
  });

  it('sanitizes a human-friendly collection name into a valid identifier', () => {
    const result = service.generateAll(input);
    expect(result.oracle.ddl).toContain('CREATE TABLE support_tickets');
    expect(result.postgres_pgvector.ddl).toContain('CREATE TABLE IF NOT EXISTS support_tickets');
    expect(result.milvus.schema.collection_name).toBe('support_tickets');
  });

  it('rejects a non-positive dimension', () => {
    expect(() => service.generateAll({ ...input, dimension: 0 })).toThrow(BadRequestException);
  });

  it('rejects an identifier that sanitizes to an empty string', () => {
    expect(() => service.generateAll({ ...input, collectionName: '!!!' })).toThrow(BadRequestException);
  });

  it('maps metadata field types to platform-appropriate column types', () => {
    const result = service.generateAll(input);
    expect(result.postgres_pgvector.ddl).toContain('source_url TEXT');
    expect(result.postgres_pgvector.ddl).toContain('published_at TIMESTAMPTZ');
    expect(result.oracle.ddl).toContain('source_url VARCHAR2(4000)');
  });

  describe('generateIndexArtifact', () => {
    const hnswParams = [
      { name: 'M', value: 16 },
      { name: 'efConstruction', value: 200 },
      { name: 'efSearch', value: 100 },
    ];
    const ivfParams = [
      { name: 'nlist', value: 1024 },
      { name: 'nprobe', value: 16 },
    ];
    const pqParams = [...ivfParams, { name: 'm', value: 8 }, { name: 'nbits', value: 8 }];

    it('generates a real Postgres HNSW index statement', () => {
      const result = service.generateIndexArtifact(VectorPlatform.POSTGRES_PGVECTOR, 'docs', IndexType.HNSW, hnswParams);
      expect(result.statement).toContain('USING hnsw');
      expect(result.statement).toContain('m = 16');
      expect(result.statement).toContain('ef_construction = 200');
    });

    it('flags that pgvector has no native PQ and falls back to ivfflat', () => {
      const result = service.generateIndexArtifact(VectorPlatform.POSTGRES_PGVECTOR, 'docs', IndexType.PQ, pqParams);
      expect(result.statement).toContain('USING ivfflat');
      expect(result.notes.some((n) => n.includes('no native Product Quantization'))).toBe(true);
    });

    it('generates a real Oracle HNSW vector index statement', () => {
      const result = service.generateIndexArtifact(VectorPlatform.ORACLE, 'docs', IndexType.HNSW, hnswParams);
      expect(result.statement).toContain('ORGANIZATION INMEMORY NEIGHBOR GRAPH');
      expect(result.statement).toContain('NEIGHBORS 16');
    });

    it('maps IVF-Flat to Oracle neighbor-partition syntax', () => {
      const result = service.generateIndexArtifact(VectorPlatform.ORACLE, 'docs', IndexType.IVF_FLAT, ivfParams);
      expect(result.statement).toContain('ORGANIZATION NEIGHBOR PARTITIONS');
      expect(result.statement).toContain('NEIGHBOR PARTITIONS 1024');
    });

    it('generates a Milvus createIndex config object for PQ', () => {
      const result = service.generateIndexArtifact(VectorPlatform.MILVUS, 'docs', IndexType.PQ, pqParams);
      const parsed = JSON.parse(result.statement);
      expect(parsed.index_type).toBe('IVF_PQ');
      expect(parsed.params).toEqual({ nlist: 1024, m: 8, nbits: 8 });
    });

    it('sanitizes the table name used in generated index identifiers', () => {
      const result = service.generateIndexArtifact(VectorPlatform.POSTGRES_PGVECTOR, 'Support Tickets', IndexType.HNSW, hnswParams);
      expect(result.statement).toContain('support_tickets_embedding_hnsw_idx');
    });

    it('generates a real Qdrant HNSW config and a quantization-based PQ approximation', () => {
      const hnsw = service.generateIndexArtifact(VectorPlatform.QDRANT, 'docs', IndexType.HNSW, hnswParams);
      expect(JSON.parse(hnsw.statement).hnsw_config).toEqual({ m: 16, ef_construct: 200 });

      const pq = service.generateIndexArtifact(VectorPlatform.QDRANT, 'docs', IndexType.PQ, pqParams);
      expect(JSON.parse(pq.statement).quantization_config.scalar.type).toBe('int8');
    });

    it('generates a LanceDB IVF_PQ config for PQ', () => {
      const result = service.generateIndexArtifact(VectorPlatform.LANCEDB, 'docs', IndexType.PQ, pqParams);
      const parsed = JSON.parse(result.statement);
      expect(parsed.index_type).toBe('IVF_PQ');
      expect(parsed.num_partitions).toBe(1024);
    });

    it('flags Pinecone and MongoDB Atlas as not exposing a user-tunable index type', () => {
      const pinecone = service.generateIndexArtifact(VectorPlatform.PINECONE, 'docs', IndexType.HNSW, hnswParams);
      expect(pinecone.notes.join(' ')).toContain('no user-facing equivalent');

      const atlas = service.generateIndexArtifact(VectorPlatform.MONGODB_ATLAS, 'docs', IndexType.HNSW, hnswParams);
      expect(atlas.notes.join(' ')).toContain('not user-tunable');
    });
  });

  describe('newly added platforms (Phase 2 schema generation)', () => {
    it('generates a schemaless Pinecone index spec and a Weaviate class with PascalCase name', () => {
      const result = service.generateAll(input);
      expect(result.pinecone.schema).toMatchObject({ name: 'support_tickets', dimension: 768, metric: 'cosine' });
      expect((result.weaviate.schema as any).class).toBe('Support_tickets');
    });

    it('generates a Redis FT.CREATE command with an HNSW vector field', () => {
      const result = service.generateAll(input);
      expect(result.redis.ddl).toContain('FT.CREATE support_tickets_idx');
      expect(result.redis.ddl).toContain('VECTOR HNSW 6 TYPE FLOAT32 DIM 768');
    });

    it('generates an Elasticsearch dense_vector mapping', () => {
      const result = service.generateAll(input);
      const properties = (result.elasticsearch.schema as any).mappings.properties;
      expect(properties.embedding).toEqual({ type: 'dense_vector', dims: 768, index: true, similarity: 'cosine' });
    });

    it('generates Actian SQL DDL with a caveat note about unverified vector syntax', () => {
      const result = service.generateAll(input);
      expect(result.actian.ddl).toContain('VECTOR(768)');
      expect(result.actian.notes.join(' ')).toContain('Best-effort');
    });

    it('generates a MongoDB Atlas vectorSearch index definition', () => {
      const result = service.generateAll(input);
      const definition = (result.mongodb_atlas.schema as any).definition;
      expect(definition.fields[0]).toEqual({ type: 'vector', path: 'embedding', numDimensions: 768, similarity: 'cosine' });
    });
  });
});
