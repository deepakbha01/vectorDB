import { BadGatewayException, BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DataExplorerService } from './data-explorer.service';
import { VectorPlatform } from '../projects/enums/platform.enum';

const requester = { id: 'u1', email: 'a@x', role: 'architect' } as any;

function setup(o: { platform?: VectorPlatform; explorable?: boolean; collections?: string[]; pipeline?: any; discovery?: any; embed?: any } = {}) {
  const adapter: any = {
    platformId: 'postgres_pgvector',
    healthCheck: jest.fn().mockResolvedValue(true),
    ...(o.explorable === false
      ? {}
      : {
          listCollections: jest.fn().mockResolvedValue(o.collections ?? ['docs']),
          describeCollection: jest.fn().mockResolvedValue({ name: 'docs', recordCount: 3, countIsEstimate: false, dimension: 3, metric: 'cosine', indexes: [], fields: [{ name: 'dept', type: 'text' }, { name: 'year', type: 'int4' }], notes: [] }),
          browse: jest.fn().mockResolvedValue({ records: [{ id: 'a', metadata: { dept: 'legal' }, vectorPreview: [0.1], dimension: 3 }], nextCursor: 'a' }),
          searchFiltered: jest.fn().mockResolvedValue([{ id: 'a', score: 0.9, metadata: {} }]),
        }),
  };
  const pipeline = o.pipeline === undefined ? { version: 1, collectionName: 'docs', embeddingDimension: 3, similarityMetric: 'cosine', metadataFields: [{ name: 'dept' }], embeddingProviderId: 'openai', embeddingModelId: 'emb' } : o.pipeline;
  const embeddings = { embed: o.embed ?? jest.fn().mockResolvedValue({ vector: [1, 0, 0], isLiveProvider: false }) };
  const service = new DataExplorerService(
    { findOne: jest.fn().mockResolvedValue({ platform: o.platform ?? VectorPlatform.POSTGRES_PGVECTOR }) } as any,
    { getAdapter: () => adapter } as any,
    { getLatest: jest.fn().mockResolvedValue(pipeline) } as any,
    { getLatest: jest.fn().mockResolvedValue({ version: 1, decision: 'hnsw' }) } as any,
    { getLatest: jest.fn().mockResolvedValue(o.discovery === undefined ? { assessment: { version: 1, estimatedVectorCount: 10, targetP95LatencyMs: 200 } } : o.discovery) } as any,
    embeddings as any,
  );
  return { service, adapter, embeddings };
}

describe('DataExplorerService', () => {
  it('reports status without failing: no platform, unsupported platform, connected', async () => {
    expect(await setup({ platform: VectorPlatform.UNDETERMINED }).service.status('p', requester)).toEqual(expect.objectContaining({ supported: false, connected: false }));
    expect((await setup({ explorable: false, platform: VectorPlatform.ACTIAN }).service.status('p', requester)).message).toMatch(/Actian has no Node.js driver/);
    expect(await setup().service.status('p', requester)).toEqual(expect.objectContaining({ supported: true, connected: true, designedCollection: 'docs' }));
  });

  it('marks the designed collection in the list', async () => {
    expect((await setup({ collections: ['docs', 'scratch'] }).service.collections('p', requester)).collections).toEqual([
      { name: 'docs', designed: true },
      { name: 'scratch', designed: false },
    ]);
  });

  it('only opens collections the database itself lists', async () => {
    const { service, adapter } = setup();
    await expect(service.overview('p', requester, 'pg_authid')).rejects.toBeInstanceOf(NotFoundException);
    expect(adapter.describeCollection).not.toHaveBeenCalled();
  });

  it('compares the collection against the design', async () => {
    const o = await setup().service.overview('p', requester, 'docs');
    expect(o.checks.find((c) => c.key === 'index')).toEqual(expect.objectContaining({ status: 'mismatch', actual: 'none' }));
  });

  it('pages with a capped limit and a typed filter', async () => {
    const { service, adapter } = setup();
    const r = await service.documents('p', requester, 'docs', { limit: 500, filter: '{"year":"2024"}' });
    expect(adapter.browse).toHaveBeenCalledWith('docs', { limit: 100, cursor: null, filter: { year: 2024 } });
    expect(r.nextCursor).toBe('a');
    await expect(service.documents('p', requester, 'docs', { filter: 'not json' })).rejects.toThrow(/must be JSON/);
    await expect(service.documents('p', requester, 'docs', { filter: '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6}' })).rejects.toThrow(/At most 5/);
  });

  it('embeds text with the project model, times the search, and says when the stand-in embedding was used', async () => {
    const { service, embeddings, adapter } = setup();
    const r = await service.search('p', requester, 'docs', { text: 'termination clause', topK: 5, filter: { dept: 'legal' } });
    expect(embeddings.embed).toHaveBeenCalledWith({ providerId: 'openai', modelId: 'emb', dimension: 3, text: 'termination clause' });
    expect(adapter.searchFiltered).toHaveBeenCalledWith('docs', { vector: [1, 0, 0], topK: 5, filter: { dept: 'legal' } });
    expect(r).toEqual(expect.objectContaining({ targetP95LatencyMs: 200, withinTarget: true, embedding: { providerId: 'openai', modelId: 'emb', live: false } }));
    expect(r.notes.join(' ')).toMatch(/offline stand-in/);
  });

  it('refuses text and vector together, a wrong dimension, and text search without an embedding design', async () => {
    const { service } = setup();
    await expect(service.search('p', requester, 'docs', { text: 'x', vector: [1, 2, 3] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.search('p', requester, 'docs', { vector: [1, 2] })).rejects.toThrow(/2 dimensions; the collection holds 3/);
    await expect(setup({ pipeline: null }).service.search('p', requester, 'docs', { text: 'x' })).rejects.toThrow(/complete Data & Embedding design/);
  });

  it('turns driver errors into a 502 without credentials, and slow calls into a 503', async () => {
    const { service, adapter } = setup();
    adapter.listCollections.mockRejectedValueOnce(new Error('connect failed postgres://admin:secret@db.internal:5432/x'));
    const err = await service.collections('p', requester).catch((e) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(err.message).not.toContain('secret');
    jest.useFakeTimers();
    adapter.listCollections.mockReturnValueOnce(new Promise(() => undefined));
    const slow = service.collections('p', requester).catch((e) => e);
    await jest.advanceTimersByTimeAsync(10_001);
    expect(await slow).toBeInstanceOf(ServiceUnavailableException);
    jest.useRealTimers();
  });
});

describe('DataExplorerService - embedding map and naming', () => {
  it("maps the design's collection name through the database's naming", async () => {
    const { service, adapter } = setup({ collections: ['Docs'] });
    adapter.designedName = (n: string) => n.charAt(0).toUpperCase() + n.slice(1);
    expect((await service.collections('p', requester)).collections).toEqual([{ name: 'Docs', designed: true }]);
    expect((await service.status('p', requester)).designedCollection).toBe('Docs');
  });

  it('samples vectors page by page, projects them on the server, and colours by a field', async () => {
    const { service, adapter } = setup();
    const rec = (i: number) => ({ id: `r${i}`, metadata: { dept: i % 3 === 0 ? 'legal' : i % 3 === 1 ? 'hr' : null }, vectorPreview: null, dimension: 3, vector: [i % 2, 1 - (i % 2), i / 100] });
    adapter.browse
      .mockResolvedValueOnce({ records: Array.from({ length: 100 }, (_, i) => rec(i)), nextCursor: 'c1' })
      .mockResolvedValueOnce({ records: Array.from({ length: 20 }, (_, i) => rec(100 + i)), nextCursor: null });
    const m = await service.map('p', requester, 'docs', { sample: 500, method: 'pca', colorBy: 'dept' });
    expect(adapter.browse).toHaveBeenNthCalledWith(1, 'docs', expect.objectContaining({ limit: 100, cursor: null, withVectors: true }));
    expect(adapter.browse).toHaveBeenNthCalledWith(2, 'docs', expect.objectContaining({ cursor: 'c1' }));
    expect(m).toEqual(expect.objectContaining({ sampled: 120, requested: 500, dimension: 3, colorBy: 'dept' }));
    expect(m.points[0]).toEqual({ id: 'r0', x: expect.any(Number), y: expect.any(Number), group: 'legal' });
    // Only ids, positions and the colour-by value leave the server.
    expect(Object.keys(m.points[0]).sort()).toEqual(['group', 'id', 'x', 'y']);
    expect(m.groups.map((g) => g.value).sort()).toEqual(['(none)', 'hr', 'legal']);
    expect(m.explainedVariance).not.toBeNull();
  });

  it('refuses an unknown colour field and says when there are too few vectors', async () => {
    const { service, adapter } = setup();
    await expect(service.map('p', requester, 'docs', { colorBy: 'owner' })).rejects.toThrow(/no field 'owner'/);
    adapter.browse.mockResolvedValueOnce({ records: [{ id: 'a', metadata: {}, vectorPreview: null, dimension: null }], nextCursor: null });
    const m = await service.map('p', requester, 'docs', {});
    expect(m.points).toEqual([]);
    expect(m.notes.join(' ')).toMatch(/without a vector/);
  });
});
