import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./db-demo.mjs', import.meta.url), 'utf8');

test('db:demo obliga al seed a restablecer la credencial propia de demo', () => {
  assert.match(source, /SEED_ADMIN_FOR_TESTS:\s*['"]1['"]/);
});
