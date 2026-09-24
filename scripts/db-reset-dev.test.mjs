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

// El destino nunca es production: ni por nombre ni por id, aunque el nombre haya pasado.
test('la cerradura rechaza production por id y por nombre, y una rama que no cuelga de ella', async () => {
  const { resetRefusal } = await import('./reset-guard.mjs');
  const production = { id: 'br-prod', name: 'production' };
  assert.match(
    resetRefusal({ id: 'br-prod', name: 'demo', parent_id: null }, production),
    /nunca se resetea/,
  );
  assert.match(
    resetRefusal({ id: 'br-x', name: 'production', parent_id: 'br-prod' }, production),
    /nunca se resetea/,
  );
  assert.match(
    resetRefusal({ id: 'br-demo', name: 'demo', parent_id: 'br-otra' }, production),
    /no cuelga de/,
  );
  assert.equal(
    resetRefusal({ id: 'br-demo', name: 'demo', parent_id: 'br-prod' }, production),
    null,
  );
});
