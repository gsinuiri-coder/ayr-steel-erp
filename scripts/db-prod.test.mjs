import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { MIGRATE_STEP, SEED_STEP, dbProdPlan } from './db-prod-plan.mjs';

const script = new URL('./db-prod.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

// D-262: sin bandera, db:prod solo migra; el seed se pide explícitamente.
test('db:prod por defecto corre solo migrate deploy', () => {
  assert.deepEqual(dbProdPlan([]), { withSeed: false, steps: [MIGRATE_STEP] });
});

test('db:prod --with-seed migra y después siembra', () => {
  assert.deepEqual(dbProdPlan(['--with-seed']), {
    withSeed: true,
    steps: [MIGRATE_STEP, SEED_STEP],
  });
});

test('db:prod rechaza una bandera desconocida antes de tocar Neon', () => {
  assert.throws(() => dbProdPlan(['--seed']), /Bandera desconocida/);
  const res = spawnSync('node', [script, '--migrate-only'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Solo acepta --with-seed/);
});
