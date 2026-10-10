import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareDrift,
  driftDbUrl,
  maintenanceUrl,
  normalizeDiff,
  statements,
} from './check-drift.mjs';

const DEFAULT_SQL = [
  '-- AlterTable',
  'ALTER TABLE "coils" ALTER COLUMN "operation_date" DROP DEFAULT;',
  '',
  '-- AlterTable',
  'ALTER TABLE "cutting_orders" ALTER COLUMN "operation_date" DROP DEFAULT;',
].join('\r\n');

test('normalizeDiff quita CRLF, espacios finales, líneas vacías y el aviso de migración vacía', () => {
  assert.equal(normalizeDiff('-- This is an empty migration.\r\n\r\n'), '');
  assert.equal(normalizeDiff('a;  \r\n\r\nb;'), 'a;\nb;');
});

test('statements separa por sentencia con su comentario', () => {
  assert.deepEqual(statements(normalizeDiff(DEFAULT_SQL)), [
    '-- AlterTable\nALTER TABLE "coils" ALTER COLUMN "operation_date" DROP DEFAULT',
    '-- AlterTable\nALTER TABLE "cutting_orders" ALTER COLUMN "operation_date" DROP DEFAULT',
  ]);
  assert.deepEqual(statements(''), []);
});

test('compareDrift: igual a lo aprobado pasa, aunque cambien los saltos de línea', () => {
  assert.deepEqual(compareDrift(DEFAULT_SQL, DEFAULT_SQL.replaceAll('\r\n', '\n')), {
    ok: true,
    added: [],
    missing: [],
  });
});

test('compareDrift: una diferencia nueva falla y se nombra', () => {
  const actual = `${DEFAULT_SQL}\n-- DropIndex\nDROP INDEX "products_finish_id_idx";`;
  const result = compareDrift(DEFAULT_SQL, actual);
  assert.equal(result.ok, false);
  assert.deepEqual(result.added, ['-- DropIndex\nDROP INDEX "products_finish_id_idx"']);
  assert.deepEqual(result.missing, []);
});

test('compareDrift: una diferencia aprobada que desaparece también falla', () => {
  const result = compareDrift(DEFAULT_SQL, '-- This is an empty migration.');
  assert.equal(result.ok, false);
  assert.equal(result.missing.length, 2);
});

test('driftDbUrl usa el Docker local fuera de CI y siempre la base ayr_drift_check', () => {
  const url = new URL(driftDbUrl({}));
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/ayr_drift_check');
});

test('driftDbUrl en GitHub Actions toma el Postgres del job y cambia solo la base', () => {
  const url = new URL(
    driftDbUrl({
      GITHUB_ACTIONS: 'true',
      DATABASE_URL: 'postgresql://ayr:x@localhost:5432/ayr_ci_e2e?schema=public',
    }),
  );
  assert.equal(url.host, 'localhost:5432');
  assert.equal(url.pathname, '/ayr_drift_check');
});

test('driftDbUrl rechaza un host que no es local (Neon)', () => {
  assert.throws(
    () =>
      driftDbUrl({
        GITHUB_ACTIONS: 'true',
        DATABASE_URL: 'postgresql://u:p@ep-x.us-east-2.aws.neon.tech/neondb',
      }),
    /solo corre contra un Postgres local/,
  );
});

test('maintenanceUrl apunta a la base postgres sin parámetros', () => {
  assert.equal(
    maintenanceUrl('postgresql://a:b@localhost:5432/ayr_drift_check?schema=public'),
    'postgresql://a:b@localhost:5432/postgres',
  );
});
