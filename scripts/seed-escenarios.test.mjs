import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbUrl } from './local-docker-env.mjs';
import { apiPort, assertEscenariosDb, escenariosDbUrl } from './seed-escenarios.mjs';

test('sin override, la base es el ayr_local del Docker y pasa el guard', () => {
  const url = escenariosDbUrl({});
  assert.equal(url, dbUrl('ayr_local'));
  assert.doesNotThrow(() => assertEscenariosDb(url));
});

test('el override puede mover el puerto y las credenciales, no el host ni la base', () => {
  assert.doesNotThrow(() =>
    assertEscenariosDb(
      escenariosDbUrl({ ESCENARIOS_DATABASE_URL: 'postgresql://ayr:x@localhost:5432/ayr_local' }),
    ),
  );
});

for (const [label, url, pattern] of [
  [
    'Neon',
    'postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require',
    /Postgres local/,
  ],
  [
    'una base ayr_local en otra máquina',
    'postgresql://u:p@10.0.0.5:5432/ayr_local',
    /Postgres local/,
  ],
  [
    'la base de la suite E2E',
    'postgresql://ayr:ayr_local@127.0.0.1:5434/ayr_local_e2e',
    /ayr_local_e2e/,
  ],
  [
    'otro nombre que empieza igual',
    'postgresql://ayr:ayr_local@127.0.0.1:5434/ayr_localx',
    /"ayr_localx"/,
  ],
  ['la base de CI', 'postgresql://ayr:ayr_ci@localhost:5432/ayr_ci_e2e', /"ayr_ci_e2e"/],
  ['otro motor', 'mysql://u:p@127.0.0.1:3306/ayr_local', /solo corre contra Postgres/],
  ['una URL rota', 'no-es-una-url', /no es válida/],
]) {
  test(`el guard rechaza ${label}`, () => {
    assert.throws(() => assertEscenariosDb(url), pattern);
  });
}

test('el puerto de la API propia es 3200 y nunca uno reservado', () => {
  assert.equal(apiPort({}), 3200);
  assert.equal(apiPort({ ESCENARIOS_API_PORT: '3250' }), 3250);
  for (const port of ['4000', '4001', '3000', '3001', '3100', '3101', '80', 'x']) {
    assert.throws(() => apiPort({ ESCENARIOS_API_PORT: port }), /no sirve/);
  }
});
