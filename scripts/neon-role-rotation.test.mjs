import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MISSING_KEY_MESSAGE,
  resolveNeonApiKey,
  rotateRolePassword,
} from './neon-role-rotation.mjs';

// P1-3 del delta RF-S4b: rotar la contraseña del rol después de resetear demo o dev.

const PROD_PASSWORD = 'la-de-production';

/** Una API de Neon simulada: registra las llamadas y responde según el guion. */
function fakeNeon({ lockedFor = 0, rotates = true, resetStatus = 200 } = {}) {
  let password = PROD_PASSWORD;
  let locked = lockedFor;
  const calls = [];
  const json = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
  const fetchImpl = async (url, init) => {
    calls.push({
      method: init.method,
      path: new URL(url).pathname,
      auth: init.headers.authorization,
    });
    if (locked > 0) {
      locked -= 1;
      return json(423, { message: 'branch is locked' });
    }
    if (url.endsWith('/reveal_password')) return json(200, { password });
    if (url.endsWith('/reset_password')) {
      if (resetStatus !== 200) return json(resetStatus, { message: `secreto ${password}` });
      if (rotates) password = 'una-nueva';
      return json(200, { role: { password }, operations: [] });
    }
    return json(404, {});
  };
  return { fetchImpl, calls };
}

const base = {
  apiKey: 'napi_test',
  projectId: 'proj',
  branchId: 'br-demo',
  sleep: async () => {},
};

test('sin NEON_API_KEY en el entorno ni en .env.setup, no hay key: el reset corta antes', () => {
  assert.equal(
    resolveNeonApiKey({}, () => ({})),
    null,
  );
  assert.equal(
    resolveNeonApiKey({ NEON_API_KEY: '  ' }, () => ({ NEON_API_KEY: '' })),
    null,
  );
  // Sin .env.setup tampoco revienta: devuelve null y el guion corta con el mensaje.
  assert.equal(
    resolveNeonApiKey({}, () => {
      throw new Error('No existe .env.setup');
    }),
    null,
  );
  assert.match(MISSING_KEY_MESSAGE, /no se resetea nada/);
});

test('la key del entorno manda sobre la de .env.setup', () => {
  assert.equal(
    resolveNeonApiKey({ NEON_API_KEY: 'env' }, () => ({ NEON_API_KEY: 'file' })),
    'env',
  );
  assert.equal(
    resolveNeonApiKey({}, () => ({ NEON_API_KEY: 'file' })),
    'file',
  );
});

test('rota sobre la rama pedida, con la key por header y nunca en la URL', async () => {
  const neon = fakeNeon();
  await rotateRolePassword({ ...base, fetchImpl: neon.fetchImpl });
  assert.deepEqual(
    neon.calls.map((c) => `${c.method} ${c.path}`),
    [
      'GET /api/v2/projects/proj/branches/br-demo/roles/neondb_owner/reveal_password',
      'POST /api/v2/projects/proj/branches/br-demo/roles/neondb_owner/reset_password',
      'GET /api/v2/projects/proj/branches/br-demo/roles/neondb_owner/reveal_password',
    ],
  );
  assert.ok(neon.calls.every((c) => c.auth === 'Bearer napi_test'));
  assert.ok(neon.calls.every((c) => !c.path.includes('napi_test')));
});

test('423 (la rama sigue ocupada por el reset) se reintenta', async () => {
  const neon = fakeNeon({ lockedFor: 3 });
  await rotateRolePassword({ ...base, fetchImpl: neon.fetchImpl });
  assert.equal(neon.calls.length, 6);
});

test('si la contraseña no cambió, falla: la rama seguiría con la de production', async () => {
  const neon = fakeNeon({ rotates: false });
  await assert.rejects(
    rotateRolePassword({ ...base, fetchImpl: neon.fetchImpl }),
    /no se aplicó.*heredada de production/,
  );
});

test('un error de la API dice el estado y nunca el cuerpo ni la contraseña', async () => {
  const neon = fakeNeon({ resetStatus: 500 });
  await assert.rejects(rotateRolePassword({ ...base, fetchImpl: neon.fetchImpl }), (err) => {
    assert.match(err.message, /HTTP 500/);
    assert.doesNotMatch(err.message, /secreto|la-de-production|napi_test/);
    return true;
  });
});

test('423 sin fin se rinde después de los intentos pedidos', async () => {
  const neon = fakeNeon({ lockedFor: 100 });
  await assert.rejects(
    rotateRolePassword({ ...base, fetchImpl: neon.fetchImpl, attempts: 4 }),
    /HTTP 423/,
  );
  assert.equal(neon.calls.length, 4);
});
