// Global Jest manual mock for `@zilliz/milvus2-sdk-node` - see __mocks__/oracledb.ts
// for why this exists as a global mock rather than per-spec-file jest.mock() calls.
// Its real transitive deps include an ESM-only `uuid` build (via thrift/parquet)
// that ts-jest cannot parse, so it must never be loaded for real during tests.
export const DataType = { VarChar: 21, FloatVector: 101, Double: 11, Bool: 1, Int64: 5, JSON: 23 };

export const MilvusClient = jest.fn().mockImplementation(function MockMilvusClient() {
  return {
    checkHealth: jest.fn(() =>
      Promise.reject(new Error('Milvus SDK is globally mocked in tests - see backend/src/__mocks__/@zilliz/milvus2-sdk-node.ts')),
    ),
    createCollection: jest.fn(),
    createIndex: jest.fn(),
    upsert: jest.fn(),
    search: jest.fn(),
    delete: jest.fn(),
    dropCollection: jest.fn(),
  };
});
