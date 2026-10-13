import assert from 'node:assert/strict';
import test from 'node:test';
import {
  argValue,
  fetchShaField,
  gitContains,
  mismatchMessage,
  shaMatches,
  waitForSha,
} from './smoke-version.mjs';

const LONG = '4cc9fc21aa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d';

test('coincide un sha corto con el largo del mismo commit, en los dos sentidos', () => {
  assert.equal(shaMatches('4cc9fc21', LONG), true);
  assert.equal(shaMatches(LONG, '4cc9fc21'), true);
  assert.equal(shaMatches('4CC9FC21', LONG), true);
});

test('no coincide otro commit, «dev» ni algo vacío', () => {
  assert.equal(shaMatches('31adda6f', LONG), false);
  assert.equal(shaMatches('4cc9fc21', 'dev'), false);
  assert.equal(shaMatches('4cc9fc21', null), false);
  assert.equal(shaMatches('', ''), false);
  // Menos de 7 caracteres es ambiguo.
  assert.equal(shaMatches('4cc9', LONG), false);
});

test('argValue lee el sha de la bandera y rechaza uno inválido', () => {
  assert.equal(argValue(['--expect-sha', 'ABCDEF12'], '--expect-sha'), 'abcdef12');
  assert.equal(argValue([], '--expect-sha'), null);
  assert.throws(() => argValue(['--expect-sha'], '--expect-sha'), /7 a 40/);
  assert.throws(() => argValue(['--expect-sha', '--base-url'], '--expect-sha'), /7 a 40/);
  assert.throws(() => argValue(['--expect-sha', 'main'], '--expect-sha'), /7 a 40/);
});

/** Un reloj falso: `sleep` adelanta el tiempo sin esperar. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

test('coincide al primer intento', async () => {
  const clock = fakeClock();
  const r = await waitForSha({ expected: '4cc9fc21', readSha: async () => LONG, ...clock });
  assert.deepEqual(r, { ok: true, published: LONG, attempts: 1, error: null });
});

test('reintenta mientras publica el commit anterior y para al coincidir', async () => {
  const clock = fakeClock();
  const seq = ['31adda6f', '31adda6f', LONG];
  const seen = [];
  const r = await waitForSha({
    expected: '4cc9fc21',
    readSha: async () => seq.shift(),
    intervalMs: 15_000,
    onAttempt: (a) => seen.push(a.published),
    ...clock,
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  assert.deepEqual(seen, ['31adda6f', '31adda6f']);
  assert.equal(clock.now(), 30_000);
});

test('un error de red cuenta como «todavía no»', async () => {
  const clock = fakeClock();
  let n = 0;
  const r = await waitForSha({
    expected: '4cc9fc21',
    readSha: async () => {
      n += 1;
      if (n === 1) throw new Error('ECONNRESET');
      return LONG;
    },
    ...clock,
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
});

test('no coincide hasta el tope: falla con el último sha leído', async () => {
  const clock = fakeClock();
  const r = await waitForSha({
    expected: '4cc9fc21',
    readSha: async () => '31adda6f',
    timeoutMs: 10 * 60_000,
    intervalMs: 15_000,
    ...clock,
  });
  assert.equal(r.ok, false);
  assert.equal(r.published, '31adda6f');
  // 0 s, 15 s, …, 600 s: 41 lecturas, nunca más allá del tope.
  assert.equal(r.attempts, 41);
  assert.ok(clock.now() <= 10 * 60_000);
});

test('acepta un commit posterior que contiene al esperado (otra sesión mergeó)', async () => {
  const clock = fakeClock();
  const seen = [];
  const r = await waitForSha({
    expected: '4cc9fc21',
    readSha: async () => 'b65e396b',
    contains: async (exp, pub) => {
      seen.push([exp, pub]);
      return true;
    },
    ...clock,
  });
  assert.equal(r.ok, true);
  assert.equal(r.newer, true);
  assert.deepEqual(seen, [['4cc9fc21', 'b65e396b']]);
});

test('un commit que no contiene al esperado sigue esperando', async () => {
  const clock = fakeClock();
  const r = await waitForSha({
    expected: '4cc9fc21',
    readSha: async () => '31adda6f',
    contains: async () => false,
    timeoutMs: 30_000,
    intervalMs: 15_000,
    ...clock,
  });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3);
});

test('dos esperas comparten el tope absoluto', async () => {
  const clock = fakeClock();
  const deadline = 60_000;
  const first = await waitForSha({
    expected: '4cc9fc21',
    readSha: async () => '31adda6f',
    deadline,
    intervalMs: 15_000,
    ...clock,
  });
  assert.equal(first.ok, false);
  const second = await waitForSha({
    expected: '4cc9fc21',
    readSha: async () => '31adda6f',
    deadline,
    intervalMs: 15_000,
    ...clock,
  });
  // La segunda ya no tiene tiempo: una sola lectura.
  assert.equal(second.attempts, 1);
  assert.ok(clock.now() <= deadline);
});

test('gitContains pregunta a git si el esperado es ancestro del publicado', () => {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: 0 };
  };
  assert.equal(gitContains('/repo', spawn)('4cc9fc21', 'b65e396b'), true);
  assert.deepEqual(calls[1], ['git', 'merge-base', '--is-ancestor', '4cc9fc21', 'b65e396b']);
  const no = () => ({ status: 1 });
  assert.equal(gitContains('/repo', no)('4cc9fc21', 'b65e396b'), false);
});

test('--expect-sha=<sha> se rechaza en vez de ignorarse', () => {
  assert.throws(() => argValue(['--expect-sha=abcdef12'], '--expect-sha'), /espacio/);
});

test('un build «dev» falla al instante, sin esperar el tope', async () => {
  const clock = fakeClock();
  const r = await waitForSha({ expected: '4cc9fc21', readSha: async () => 'dev', ...clock });
  assert.deepEqual(r, { ok: false, published: 'dev', attempts: 1, error: null });
  assert.equal(clock.now(), 0);
});

test('el mensaje dice dónde, sha esperado y sha publicado', () => {
  const msg = mismatchMessage({
    where: 'https://v2.mareliac.pe/version',
    expected: '4cc9fc21',
    published: '31adda6f',
    error: null,
    timeoutMs: 600_000,
  });
  assert.match(msg, /v2\.mareliac\.pe/);
  assert.match(msg, /Esperado 4cc9fc21/);
  assert.match(msg, /publicado 31adda6f/);
  assert.match(msg, /10 min/);
});

test('fetchShaField lee el campo y trata un HTTP no 200 como error', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ sha: LONG, builtAt: 'x' }) });
  assert.equal(await fetchShaField(ok, 'u', 'sha'), LONG);
  const notFound = async () => ({ ok: false, status: 404 });
  await assert.rejects(fetchShaField(notFound, 'u', 'sha'), /HTTP 404/);
  const noField = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  assert.equal(await fetchShaField(noField, 'u', 'sha'), null);
});

test('fetchShaField: una página HTML es «todavía no publica /version», no un error de JSON', async () => {
  const html = async () => ({
    ok: true,
    json: async () => JSON.parse('<!DOCTYPE html><html></html>'),
  });
  await assert.rejects(
    fetchShaField(html, 'https://v2.example.pe/version', 'sha'),
    (err) => err.message === 'la web aún no publica /version; reintentando…',
  );
  await assert.rejects(
    fetchShaField(html, 'https://api.example.pe/api/health', 'sha'),
    //api/health todavía no responde JSON; reintentando…/,
  );
  // Otro error (no de JSON) sale tal cual.
  const broken = async () => ({
    ok: true,
    json: async () => {
      throw new TypeError('cuerpo ya leído');
    },
  });
  await assert.rejects(fetchShaField(broken, 'u', 'sha'), /cuerpo ya leído/);
});

test('fetchShaField corta una lectura colgada en su tope', async () => {
  // Un fetch que nunca responde salvo que lo aborten.
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  const started = Date.now();
  await assert.rejects(fetchShaField(hang, 'u', 'sha', 50), /timeout|abort/i);
  assert.ok(Date.now() - started < 5000);
});
