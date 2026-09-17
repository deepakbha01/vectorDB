// Global Jest manual mock for the `oracledb` native/Thin-mode driver.
//
// `oracledb` is a real dependency of OracleVectorAdapter, but its transitive
// deps are heavy and irrelevant to unit tests; more importantly, any test
// file that merely imports a type from VectorAdapterFactory (even without
// using Oracle at all) pulls this module in. Jest auto-applies a manual mock
// placed here to every `require('oracledb')` across the whole suite, so no
// individual spec file needs its own `jest.mock('oracledb', ...)` unless it
// wants to assert something oracledb-specific (in which case it can still
// call `jest.mock('oracledb', factory)` locally - an explicit factory in a
// spec file always wins over this default for that file).
const mockOracledb = {
  outFormat: 0,
  OUT_FORMAT_OBJECT: 1,
  DB_TYPE_VECTOR: 'DB_TYPE_VECTOR',
  createPool: jest.fn(() =>
    Promise.reject(new Error('oracledb is globally mocked in tests - see backend/src/__mocks__/oracledb.ts')),
  ),
};

export default mockOracledb;

