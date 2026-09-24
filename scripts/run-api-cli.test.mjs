import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { EXTERNAL_OUTPUTS_OFF } from './run-api-cli.mjs';

const source = readFileSync(new URL('./run-api-cli.mjs', import.meta.url), 'utf8');

// Revisión cruzada RF-S4b (P1-2): las CLI de dominio corren sin cola, sin PSE y sin R2.
test('run-api-cli apaga la cola, el PSE y R2 del proceso hijo', () => {
  assert.deepEqual(
    { ...EXTERNAL_OUTPUTS_OFF },
    {
      JOBS_ENABLED: 'false',
      PSE_ENABLED: 'false',
      R2_ACCOUNT_ID: '',
      R2_ACCESS_KEY_ID: '',
      R2_SECRET_ACCESS_KEY: '',
      R2_BUCKET: '',
      R2_ENDPOINT: '',
    },
  );
});

test('las salidas apagadas pisan al entorno heredado, no al revés', () => {
  const inherited = source.indexOf('...process.env,');
  const off = source.indexOf('...EXTERNAL_OUTPUTS_OFF,');
  assert.ok(inherited > -1 && off > -1, 'el entorno del hijo tiene que armarse con los dos');
  assert.ok(off > inherited, 'EXTERNAL_OUTPUTS_OFF tiene que ir después de process.env');
});
