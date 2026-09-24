import { test } from 'node:test';
import assert from 'node:assert/strict';
import { e2eApiPort } from './local-docker-env.mjs';

// El puerto del API que levanta la suite E2E local. Existe porque otro proyecto del dueño
// escuchaba en [::1]:3000, Playwright lo reusaba creyendo que era el API y la suite fallaba con
// errores que no se parecían a su causa.

test('sin E2E_API_PORT, el de siempre: 3000', () => {
  assert.equal(e2eApiPort({}), 3000);
  assert.equal(e2eApiPort({ E2E_API_PORT: '' }), 3000);
});

test('con E2E_API_PORT, ese', () => {
  assert.equal(e2eApiPort({ E2E_API_PORT: '3100' }), 3100);
  assert.equal(e2eApiPort({ E2E_API_PORT: ' 3200 ' }), 3200);
});

test('rechaza lo que no es un puerto', () => {
  for (const value of ['abc', '3000.5', '-1', '0', '80', '70000', '3e3']) {
    assert.throws(() => e2eApiPort({ E2E_API_PORT: value }), /E2E_API_PORT/, value);
  }
});

test('rechaza los puertos del dueño y los que ya usa la suite', () => {
  // 4000/4001: `dev:preview` del dueño (AGENTS.md §3.5). 3001: el web. 3002: el stub del padrón.
  for (const value of ['4000', '4001', '3001', '3002']) {
    assert.throws(() => e2eApiPort({ E2E_API_PORT: value }), /E2E_API_PORT/, value);
  }
});
