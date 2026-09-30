import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  PSE_SERIES,
  acquirePseLock,
  assertDemoPseConfig,
  assertPseArguments,
  assertPseObserved,
  assertPseReport,
  confirmedPseCorrelatives,
  nextPseBases,
  pseAccountFingerprint,
  pseRunEnv,
} from './e2e-pse-correlatives.mjs';

test('dos corridas PSE avanzan 100 por serie sin saltar con el reloj', () => {
  const last = Object.fromEntries(PSE_SERIES.map((series, index) => [series, 39_420_975 + index]));
  const first = nextPseBases(last);
  const actualFirst = Object.fromEntries(PSE_SERIES.map((series) => [series, first[series] + 7]));
  const second = nextPseBases(actualFirst);
  for (const series of PSE_SERIES) {
    assert.equal(first[series], last[series] + 100);
    assert.equal(second[series], actualFirst[series] + 100);
  }
});

test('falta de serie o fin de numeración detiene el gate antes de emitir', () => {
  const last = Object.fromEntries(PSE_SERIES.map((series) => [series, 39_420_975]));
  delete last.FC01;
  assert.throws(() => nextPseBases(last), /FC01/);
  last.FC01 = 99_999_899;
  assert.throws(() => nextPseBases(last), /FC01/);
});

test('se verifica el último número realmente usado por cada serie', () => {
  const bases = Object.fromEntries(PSE_SERIES.map((series) => [series, 39_421_000]));
  const observed = Object.fromEntries(PSE_SERIES.map((series) => [series, 39_421_023]));
  assert.doesNotThrow(() => assertPseObserved(bases, observed));
  observed.B001 = 39_420_999;
  assert.throws(() => assertPseObserved(bases, observed), /B001/);
});

test('una serie sin emisión conserva el último de Nubefact entre corridas', () => {
  const last = {
    ...Object.fromEntries(PSE_SERIES.map((series) => [series, 39_420_975])),
    BC01: null,
  };
  const first = nextPseBases(last);
  const observed = Object.fromEntries(PSE_SERIES.map((series) => [series, first[series] + 3]));
  observed.T001 = first.T001;
  const confirmed = confirmedPseCorrelatives(last, first, observed);
  assert.equal(confirmed.T001, last.T001);
  assert.equal(nextPseBases(confirmed).T001, first.T001);
  assert.equal(confirmed.BC01, null);
  assert.equal(confirmed.F001, first.F001 + 3);
});

test('el gate fuerza Docker E2E aunque herede otra URL o el reset apagado', () => {
  const env = pseRunEnv(
    {
      CI: 'true',
      E2E_BASE_URL: 'https://example.test',
      E2E_RESET_DB: '0',
      DATABASE_URL: 'neon',
      NUBEFACT_URL: 'otra-cuenta',
      R2_BUCKET: 'bucket-real',
    },
    { F001: 100 },
    'postgresql://local/e2e',
    {
      NUBEFACT_URL: 'cuenta-demo',
      NUBEFACT_TOKEN: 'token-demo',
      E2E_CUSTOMER_RUC: '20123456789',
      PSE_ENABLED: 'true',
    },
  );
  assert.equal(env.CI, '');
  assert.equal(env.E2E_BASE_URL, undefined);
  assert.equal(env.E2E_RESET_DB, '1');
  assert.equal(env.DATABASE_URL, 'postgresql://local/e2e');
  assert.equal(env.DIRECT_URL, 'postgresql://local/e2e');
  assert.equal(env.NUBEFACT_URL, 'cuenta-demo');
  assert.equal(env.R2_BUCKET, 'ayr-e2e');
  assert.equal(env.R2_ENDPOINT, 'http://127.0.0.1:9000');
});

test('el gate no considera verde una corrida saltada', () => {
  const spec = { tags: ['pse'], tests: [{}] };
  const report = {
    stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
    suites: [{ suites: [{ specs: [spec] }] }],
  };
  assert.doesNotThrow(() => assertPseReport(report));
  assert.doesNotThrow(() => assertPseArguments(['e2e/tests/fase5b-bordes.spec.ts']));
  assert.throws(() =>
    assertPseReport({ stats: { expected: 0, skipped: 12, unexpected: 0, flaky: 0 } }),
  );
  assert.throws(() => assertPseReport({ ...report, suites: [] }), /@pse/);
  assert.throws(() => assertPseReport({ ...report, suites: [{ specs: [{ ...spec, tags: [] }] }] }));
  assert.throws(() => assertPseArguments(['-g', 'otro']), /opciones/);
  assert.throws(() => assertPseArguments(['--config=otra.ts']), /opciones/);
});

test('solo un worktree puede reservar correlativos a la vez', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ayr-pse-'));
  const path = join(dir, 'state.json');
  try {
    const release = acquirePseLock(path);
    assert.throws(() => acquirePseLock(path), /existe/);
    release();
    const releaseAgain = acquirePseLock(path);
    releaseAgain();
  } finally {
    rmdirSync(dir);
  }
});

test('el estado distingue cuentas PSE sin guardar el token', () => {
  const first = pseAccountFingerprint({ NUBEFACT_URL: 'demo', NUBEFACT_TOKEN: 'uno' });
  const second = pseAccountFingerprint({ NUBEFACT_URL: 'demo', NUBEFACT_TOKEN: 'dos' });
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /uno|demo/);
});

test('el gate exige la cuenta Nubefact demo antes de reservar correlativos', () => {
  const setup = {
    NUBEFACT_DEMO_URL: 'https://demo.example.test',
    NUBEFACT_DEMO_TOKEN: 'demo-token',
    NUBEFACT_URL: 'https://real.example.test',
    NUBEFACT_TOKEN: 'real-token',
  };
  const local = {
    NUBEFACT_URL: setup.NUBEFACT_DEMO_URL,
    NUBEFACT_TOKEN: setup.NUBEFACT_DEMO_TOKEN,
  };
  assert.doesNotThrow(() => assertDemoPseConfig(local, setup));
  assert.throws(
    () => assertDemoPseConfig({ ...local, NUBEFACT_TOKEN: setup.NUBEFACT_TOKEN }, setup),
    /demo/,
  );
  assert.throws(() => assertDemoPseConfig(local, {}), /credenciales explícitas/);
});
