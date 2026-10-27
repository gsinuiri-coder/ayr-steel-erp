import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { forbiddenUploadPaths, missingRequiredPaths } from './upload-guard.mjs';

// cc68 (D-726): el paquete del deploy de la API no lleva local-data/ ni archivos de entorno.

test('marca local-data/ en cualquier nivel y con cualquier separador', () => {
  assert.deepEqual(
    forbiddenUploadPaths([
      'apps\\api\\src\\main.ts',
      'local-data\\cc68\\lectura.json',
      'local-data/drywall/INFORME.md',
      'apps/api/local-data/x.log',
      'package.json',
    ]),
    [
      'local-data\\cc68\\lectura.json',
      'local-data/drywall/INFORME.md',
      'apps/api/local-data/x.log',
    ],
  );
});

test('marca los archivos de entorno y no otros que se les parecen', () => {
  const env = ['.env', 'secretos'].join('');
  assert.deepEqual(
    forbiddenUploadPaths([
      '.env',
      ['.env', 'setup'].join('.'),
      `apps\\web\\${['.env', 'local'].join('.')}`,
      'apps/api/src/config/env.ts',
      'docs/environment.md',
      env,
    ]),
    ['.env', ['.env', 'setup'].join('.'), `apps\\web\\${['.env', 'local'].join('.')}`],
  );
});

test('.gcloudignore excluye local-data y los archivos de entorno', () => {
  const lines = readFileSync(resolve(import.meta.dirname, '..', '.gcloudignore'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim());
  for (const rule of ['local-data', '**/local-data', '.env', '.env.*', '**/.env', '**/.env.*']) {
    assert.ok(lines.includes(rule), `falta «${rule}» en .gcloudignore`);
  }
});

test('un listado vacío o sin el Dockerfile no prueba nada (autorrevisión P2-3)', () => {
  assert.deepEqual(missingRequiredPaths([]), ['Dockerfile', 'apps/api/package.json']);
  assert.deepEqual(missingRequiredPaths(['Dockerfile', 'apps\\api\\package.json']), []);
});
