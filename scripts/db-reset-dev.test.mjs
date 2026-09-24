import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./db-reset-dev.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

// RF-S4b: el reset repone `dev` o `demo` desde production, y ninguna otra rama.
test('db-reset-dev rechaza cualquier rama que no sea dev o demo, antes de tocar Neon', () => {
  for (const branch of ['production', 'ci', 'respaldo-pre-v4-20260915']) {
    const res = spawnSync('node', [script, '--branch', branch, '--yes'], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--branch solo acepta dev o demo/);
  }
});

test('db-reset-dev sin --yes no hace nada', () => {
  const res = spawnSync('node', [script, '--branch', 'demo'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Vuelve a correrlo con --yes/);
});
