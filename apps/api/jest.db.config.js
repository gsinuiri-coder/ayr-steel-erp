/**
 * D-372 (cc15b): tests de `InventoryService` **contra una base real** (`*.db-spec.ts`), para lo
 * que un mock no puede probar: los locks, la concurrencia y la precondición de `replaceEntry`
 * comprobada en SQL. Solo corren contra una base de pruebas (`test-db-guard.ts`), después del
 * reset: `pnpm --filter @ayr/api test:db`. En CI van en el job `base` (D-596), contra el Postgres del
 * runner. Mismo transform que `jest.config.js`; sin cobertura (la mide `test:cov`).
 */
const base = require('./jest.config.js');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  roots: ['<rootDir>/apps/api/src'],
  testRegex: '.*\\.db-spec\\.ts$',
  collectCoverageFrom: undefined,
  coverageDirectory: undefined,
};
