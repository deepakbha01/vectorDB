// Global Jest manual mock for `weaviate-client` - see __mocks__/oracledb.ts for
// why this exists as a global mock rather than per-spec-file jest.mock() calls.
// Its bundled `uuid` dependency ships an ESM-only build that ts-jest cannot
// parse, so it must never be loaded for real during tests.
export class ApiKey {
  constructor(public apiKey: string) {}
}

const mockCollection = {
  data: {
    insertMany: jest.fn(),
    deleteById: jest.fn(),
  },
  query: {
    nearVector: jest.fn(),
  },
};

const mockClient = {
  isReady: jest.fn(() =>
    Promise.reject(new Error('weaviate-client is globally mocked in tests - see backend/src/__mocks__/weaviate-client.ts')),
  ),
  collections: {
    createFromJson: jest.fn(),
    use: jest.fn(() => mockCollection),
    delete: jest.fn(),
  },
};

const weaviate = {
  connectToCustom: jest.fn(() => Promise.resolve(mockClient)),
  ApiKey,
};

export default weaviate;
