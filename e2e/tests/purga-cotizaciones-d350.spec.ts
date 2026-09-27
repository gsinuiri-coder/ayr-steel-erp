import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { adminApi, createFinish, postJson } from '../helpers/api';
import {
  createCustomer,
  createQuotation,
  createSellableProduct,
  purgeSalesTrail,
} from '../helpers/sales';
import { quoteAndOrder, setupRoofingScenario } from '../helpers/roofing';

/**
 * D-350 — la CLI real de la purga de cotizaciones anuladas, contra la base de pruebas: el dry-run
 * no borra nada, el `--execute` borra la anulada y deja la emitida (bloqueada, con su motivo), y
 * el producto que solo usaba la anulada queda borrable (`canDelete`).
 */

test.skip(!!process.env.E2E_BASE_URL, 'Borra datos: nunca contra producción (D-126).');
test.describe.configure({ timeout: 360_000 });

function purge(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(
    'node',
    ['scripts/purge-cancelled-quotations.mjs', '--branch', 'local-e2e', ...args],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 300_000 },
  );
}

test('D-350 — dry-run, execute y bloqueo de una no anulada', async ({ baseURL }) => {
  const api = await adminApi(baseURL!);
  const finish = await createFinish(api, { businessLine: 'metallic-roofing' });
  const product = await createSellableProduct(api, {
    lineCode: 'metallic-roofing',
    finishId: finish.id,
    listPricePen: '50',
    roofingKind: 'PLANCHA',
  });
  const customer = await createCustomer(api);
  const quote = () =>
    createQuotation(api, {
      customerId: customer.id,
      businessLine: 'metallic-roofing',
      productId: product.id,
      qty: '2',
    });
  const cancelled = await quote();
  const live = await quote();
  await postJson(api, `/api/sales/quotations/${cancelled.id}/cancel`, {
    reason: 'Prueba E2E de D-350',
  });
  // Segundo modelo (P1): el bloqueo «tiene pedido» contra Postgres real. Confirmar crea el pedido;
  // anularlo devuelve la cotización a EMITIDA, y recién entonces se anula: queda ANULADA con un
  // pedido (anulado) detrás, que la purga no puede tocar.
  // Confirmar exige stock: se cotiza sobre el escenario de coberturas, que trae su bobina.
  const scenario = await setupRoofingScenario(api, { weightKg: '1000' });
  const { quotation: ordered, order } = await quoteAndOrder(api, {
    customerId: customer.id,
    productId: scenario.product.id,
    rows: [{ lengthMm: '3000', qty: 2 }],
  });
  await purgeSalesTrail(api, { orderIds: [order.id], quotationIds: [ordered.id] });
  const numbers = `${cancelled.code},${live.code},${ordered.code}`;

  // Dry-run: informa, no borra.
  const dry = purge(['--numbers', numbers]);
  expect(dry.status, dry.stderr).toBe(0);
  expect(dry.stdout).toContain(`A borrar: 1`);
  expect(dry.stdout).toContain(`${cancelled.code}  CANCELLED`);
  expect(dry.stdout).toMatch(new RegExp(`${live.code}\\s+EMITTED\\s+está EMITTED, no ANULADA`));
  expect(dry.stdout).toMatch(
    new RegExp(`${ordered.code}\\s+CANCELLED\\s+tiene pedido\\(s\\) ${order.code}`),
  );
  expect((await api.get(`/api/sales/quotations/${cancelled.id}`)).status()).toBe(200);

  // Execute: se va la anulada; la emitida queda.
  const run = purge(['--numbers', numbers, '--execute']);
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain('Borradas: 1');
  expect((await api.get(`/api/sales/quotations/${cancelled.id}`)).status()).toBe(404);
  expect((await api.get(`/api/sales/quotations/${live.id}`)).status()).toBe(200);
  // La anulada con pedido detrás sigue ahí: la purga no la tocó.
  expect((await api.get(`/api/sales/quotations/${ordered.id}`)).status()).toBe(200);

  // El producto sigue usado por la emitida: todavía no es borrable.
  const after = (await (await api.get(`/api/catalog/${product.id}`)).json()) as {
    canDelete: boolean;
  };
  expect(after.canDelete).toBe(false);
});
