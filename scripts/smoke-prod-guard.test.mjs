import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedSmokeBaseUrl } from './smoke-prod-guard.mjs';

test('acepta el dominio propio de production y el de Vercel', () => {
  assert.equal(isAllowedSmokeBaseUrl('https://v2.mareliac.pe'), true);
  assert.equal(isAllowedSmokeBaseUrl('https://ayr-steel-erp-web.vercel.app'), true);
});

test('rechaza http, hosts ajenos y parecidos al propio', () => {
  for (const url of [
    'http://v2.mareliac.pe',
    'https://mareliac.pe.evil.com',
    'https://v2.mareliac.pe.evil.com',
    'https://evilmareliac.pe',
    'https://ejemplo.com',
    'no-es-una-url',
  ]) {
    assert.equal(isAllowedSmokeBaseUrl(url), false, url);
  }
});
