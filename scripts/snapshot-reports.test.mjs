import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { isProductionHost, snapshotPlan } from './snapshot-reports-plan.mjs';

const script = new URL('./snapshot-reports.mjs', import.meta.url).pathname.replace(
  /^\/(\w:)/,
  '$1',
);
const fixed = { randomSuffix: () => 'abc123' };

// P1-2 del delta RF-S4b: sin destino explícito no hay foto, y nunca cae en production sola.
test('snapshot sin --base-url se rechaza: no hay default a production', () => {
  assert.throws(() => snapshotPlan(['snapshot', 'antes', '--out', 'x']), /Falta --base-url/);
  // El script corta antes de leer credenciales o tocar Neon.
  const res = spawnSync('node', [script, 'snapshot', 'antes', '--out', 'x'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Falta --base-url/);
});

test('el admin efímero exige --branch', () => {
  assert.throws(
    () =>
      snapshotPlan([
        'snapshot',
        'antes',
        '--out',
        'x',
        '--base-url',
        'http://localhost:3000/api',
        '--ephemeral-admin',
      ]),
    /exige --branch/,
  );
});

test('escenario A: una API local con --branch production se rechaza', () => {
  assert.throws(
    () =>
      snapshotPlan([
        'snapshot',
        'demo-antes',
        '--out',
        'x',
        '--base-url',
        'http://localhost:3000/api',
        '--ephemeral-admin',
        '--branch',
        'production',
      ]),
    /--branch production solo con un host de production/,
  );
});

test('un host de production con --branch demo se rechaza', () => {
  assert.throws(
    () =>
      snapshotPlan([
        'snapshot',
        'antes',
        '--out',
        'x',
        '--base-url',
        'https://v2.mareliac.pe/api',
        '--ephemeral-admin',
        '--branch',
        'demo',
      ]),
    /es production: el admin efímero va en --branch production/,
  );
});

test('un host desconocido no recibe admin efímero', () => {
  assert.throws(
    () =>
      snapshotPlan([
        'snapshot',
        'antes',
        '--out',
        'x',
        '--base-url',
        'https://otra-cosa.example.com/api',
        '--ephemeral-admin',
        '--branch',
        'demo',
      ]),
    /No sé qué rama sirve/,
  );
});

test('la foto de demo crea el admin en demo, con un correo propio de la corrida', () => {
  const plan = snapshotPlan(
    [
      'snapshot',
      'demo-antes',
      '--out',
      'local-data/x',
      '--base-url',
      'http://localhost:3000/api/',
      '--ephemeral-admin',
      '--branch',
      'demo',
    ],
    fixed,
  );
  assert.deepEqual(plan, {
    mode: 'snapshot',
    target: 'demo-antes',
    baseUrl: 'http://localhost:3000/api',
    out: 'local-data/x',
    envFile: null,
    ephemeral: { branch: 'demo', email: 'e2e-snapshot-abc123@ayr.test' },
  });
});

test('la foto de production crea el admin en production', () => {
  const plan = snapshotPlan(
    [
      'quotation',
      'COT-000002',
      '--out',
      'x',
      '--base-url',
      'https://v2.mareliac.pe/api',
      '--ephemeral-admin',
      '--branch',
      'production',
    ],
    fixed,
  );
  assert.equal(plan.ephemeral.branch, 'production');
  assert.equal(plan.ephemeral.email, 'e2e-snapshot-abc123@ayr.test');
});

test('cada corrida tiene su propio correo: la limpieza no alcanza a otra', () => {
  const argv = [
    'snapshot',
    'a',
    '--out',
    'x',
    '--base-url',
    'https://v2.mareliac.pe/api',
    '--ephemeral-admin',
    '--branch',
    'production',
  ];
  assert.notEqual(snapshotPlan(argv).ephemeral.email, snapshotPlan(argv).ephemeral.email);
});

test('sin admin efímero no hace falta rama, y --branch suelto se rechaza', () => {
  const plan = snapshotPlan([
    'snapshot',
    'a',
    '--out',
    'x',
    '--base-url',
    'http://localhost:3000/api',
    '--env-file',
    '.env.demo',
  ]);
  assert.equal(plan.ephemeral, null);
  assert.equal(plan.envFile, '.env.demo');
  assert.throws(
    () =>
      snapshotPlan([
        'snapshot',
        'a',
        '--out',
        'x',
        '--base-url',
        'http://localhost:3000/api',
        '--branch',
        'demo',
      ]),
    /solo tiene sentido con --ephemeral-admin/,
  );
});

test('una bandera desconocida corta', () => {
  assert.throws(
    () => snapshotPlan(['snapshot', 'a', '--out', 'x', '--baseurl', 'http://localhost:3000']),
    /Bandera desconocida/,
  );
});

test('compare no pide destino', () => {
  assert.deepEqual(snapshotPlan(['compare', 'a.json', 'b.json']), {
    mode: 'compare',
    files: ['a.json', 'b.json'],
  });
});

test('hosts de production', () => {
  for (const h of ['v2.mareliac.pe', 'ayr-steel-erp-web.vercel.app', 'x.a.run.app']) {
    assert.equal(isProductionHost(h), true, h);
  }
  for (const h of ['localhost', '127.0.0.1', 'mareliac.pe.example.com']) {
    assert.equal(isProductionHost(h), false, h);
  }
});
