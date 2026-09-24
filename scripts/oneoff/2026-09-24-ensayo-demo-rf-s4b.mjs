// Ensayo de RF-S4b en demo (2026-09-24). Script de un solo uso: se crea, se corre y se borra en
// la misma sesión (AGENTS.md §3.3). Solo contra el API local levantado con `pnpm dev:demo`.
//
// Uso:
//   node scripts/oneoff/2026-09-24-ensayo-demo-rf-s4b.mjs snapshot <etiqueta>
//   node scripts/oneoff/2026-09-24-ensayo-demo-rf-s4b.mjs cot000002 [--confirm]
//
// La contraseña del admin de demo se lee de `.env.demo` y no se imprime.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, readEnvFile } from '../lib.mjs';

const API = 'http://localhost:3000';
const OUT = resolve(ROOT, 'local-data/rf-s4b/ensayo-demo');

async function login() {
  const env = readEnvFile(resolve(ROOT, '.env.demo'));
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login en demo falló: ${res.status}`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  return cookies.join('; ');
}

async function call(cookie, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function snapshot(label) {
  const cookie = await login();
  const valuation = await call(cookie, 'GET', '/reports/inventory-valuation');
  const august = await call(cookie, 'GET', '/reports/sales-margin?from=2026-08-01&to=2026-08-31');
  const all = await call(cookie, 'GET', '/reports/sales-margin?from=2026-01-01&to=2026-12-31');
  const catalog = await call(cookie, 'GET', '/catalog');
  const bob = catalog.filter((p) => p.sku.toUpperCase().startsWith('BOB'));
  const result = {
    label,
    at: new Date().toISOString(),
    inventoryValuation: valuation.totals,
    salesMarginAugust: august.totals,
    salesMarginYear: all.totals,
    bobActive: bob.filter((p) => p.isActive).length,
    bobInactive: bob.filter((p) => !p.isActive).length,
    bobActiveSkus: bob.filter((p) => p.isActive).map((p) => p.sku).sort(),
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, `snapshot-${label}.json`), JSON.stringify(result, null, 2));
  const { bobActiveSkus: _skus, ...shown } = result;
  console.log(JSON.stringify(shown, null, 2));
}

async function cot000002(confirm) {
  const cookie = await login();
  const list = await call(cookie, 'GET', '/sales/quotations?pageSize=200&q=COT-000002');
  const hit = (list.items ?? []).find((q) => q.code === 'COT-000002');
  if (!hit) throw new Error('COT-000002 no está en demo');
  const q = await call(cookie, 'GET', `/sales/quotations/${hit.id}`);
  const summary = {
    code: q.code,
    status: q.status,
    totalPen: q.totalPen,
    items: q.items.map((i) => ({
      productSku: i.productSku,
      qty: i.qty,
      reserveItemType: i.reserveItemType,
      reserveItemLabel: i.reserveItemLabel,
      subtotalPen: i.subtotalPen,
      igvPen: i.igvPen,
      totalPen: i.totalPen,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!confirm) return;
  const order = await call(cookie, 'POST', `/sales/quotations/${hit.id}/confirm`, {});
  const out = {
    orderCode: order.code,
    totalPen: order.totalPen,
    items: order.items.map((i) => ({
      productSku: i.productSku,
      reserveItemType: i.reserveItemType,
      reserveItemLabel: i.reserveItemLabel,
      totalPen: i.totalPen,
    })),
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, 'cot000002-confirmada.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'snapshot' && arg) await snapshot(arg);
else if (mode === 'cot000002') await cot000002(process.argv.includes('--confirm'));
else {
  console.error('Uso: snapshot <etiqueta> | cot000002 [--confirm]');
  process.exit(1);
}
