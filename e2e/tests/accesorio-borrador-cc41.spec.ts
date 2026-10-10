import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { canonicalAccessorySku, type RoofingReportDraftDto } from '@ayr/shared';
import { adminApi, getJson, postJson } from '../helpers/api';
import { balanceOf, today, type ProductionOrderDto } from '../helpers/production';
import { loginAsAdmin } from '../helpers/report-fixtures';
import {
  buyRoofingCoil,
  mountCoil,
  purgeRoofingTrail,
  reservationsOf,
  setupRoofingScenario,
} from '../helpers/roofing';
import { createCustomer } from '../helpers/sales';
import { openQueuedOrder } from '../helpers/ui';

/**
 * cc41 (D-591, reemplaza D-559) — **el borrador del accesorio vive en el servidor.** Lo escrito en
 * cada bloque se guarda en el borrador de la orden (D-191): sobrevive a un refresco y lo ve otro
 * navegador. «Registrar y cerrar» ejecuta el borrador entero y cierra en una sola transacción. Lo
 * que D-559 dejó en el navegador sube una vez al borrador al abrir la orden.
 *
 * Aritmética: 1 000 mm × 0.50 mm, densidad 8.0 y el 1 % de D-165 ⇒ 4.04 kg por metro. Pedido de
 * 20 m; bobinas de 30, 40 y 1 000 kg.
 */
const allowWrites = !process.env.E2E_BASE_URL;
test.skip(!allowWrites, 'Crea compras, bobinas y producción: nunca contra producción (D-126).');
test.describe.configure({ timeout: 300_000 });

interface Scenario {
  opId: string;
  opCode: string;
  orderId: string;
  accessoryId: string;
  coils: { id: string; code: string }[];
  trail: Parameters<typeof purgeRoofingTrail>[1];
}

async function scenario(api: APIRequestContext): Promise<Scenario> {
  const s = await setupRoofingScenario(api, { weightKg: '30' });
  const coils = [{ id: s.coil.id, code: s.coil.code }];
  const purchaseIds = [s.purchaseId];
  for (const weightKg of ['40', '1000']) {
    const extra = await buyRoofingCoil(api, {
      supplierId: s.supplier.id,
      finishId: s.finish.id,
      colorId: s.color.id,
      weightKg,
    });
    coils.push({ id: extra.coil.id, code: extra.coil.code });
    purchaseIds.push(extra.purchaseId);
  }
  const customer = await createCustomer(api);
  const accessory = await postJson<{ id: string }>(api, '/api/catalog', {
    businessLineId: s.product.businessLineId,
    sku: canonicalAccessorySku(s.product.thicknessMm ?? '0.50', s.color.code),
    name: 'Accesorio E2E cc41',
    unit: 'MTR',
    source: 'MANUFACTURED',
    listPricePen: '30',
    finishId: s.product.finishId,
    colorId: s.product.colorId,
    thicknessMm: s.product.thicknessMm,
    widthMm: s.product.widthMm,
    roofingKind: 'ACCESORIO',
  });
  const quotation = await postJson<{ id: string }>(api, '/api/sales/quotations', {
    customerId: customer.id,
    issueDate: today(),
    items: [{ productId: accessory.id, qty: '20.000', unitPricePen: '60' }],
  });
  const order = await postJson<{ id: string }>(
    api,
    `/api/sales/quotations/${quotation.id}/confirm`,
    {},
  );
  const opId = (await reservationsOf(api, order.id)).find(
    (r) => r.productionOrderId,
  )?.productionOrderId;
  expect(opId, 'confirmar no dejó la OP en cola').toBeTruthy();
  for (const c of coils) await mountCoil(api, opId!, { coilId: c.id });
  const op = await getJson<ProductionOrderDto>(api, `/api/production/${opId!}`);
  return {
    opId: opId!,
    opCode: op.code,
    orderId: order.id,
    accessoryId: accessory.id,
    coils,
    trail: {
      supplierId: s.supplier.id,
      finishId: s.finish.id,
      colorId: s.color.id,
      productIds: [s.product.id, accessory.id],
      coilIds: coils.map((c) => c.id),
      purchaseIds,
      productionOrderIds: [opId!],
      orderIds: [order.id],
      quotationIds: [quotation.id],
    },
  };
}

async function openOrder(page: Page, s: Scenario) {
  await page.goto(`/planta?pedido=${s.orderId}`);
  await openQueuedOrder(page, s.opCode);
  const panel = page.locator(`#panel-${s.opId}`);
  await expect(panel.getByText('Avance', { exact: true })).toBeVisible({ timeout: 60_000 });
  return panel;
}

function serverDrafts(api: APIRequestContext, s: Scenario) {
  return getJson<RoofingReportDraftDto[]>(api, `/api/production/roofing/${s.opId}/drafts`);
}

async function newLoggedPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAsAdmin(page);
  return page;
}

test.describe('cc41 — el borrador del accesorio en el servidor', () => {
  let api: APIRequestContext;
  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  test('3 bobinas: lo escrito se guarda en el servidor, sobrevive al refresco, otro navegador lo ve y «Registrar y cerrar» lo ejecuta entero', async ({
    page,
    browser,
  }) => {
    const s = await scenario(api);
    try {
      await loginAsAdmin(page);
      const panel = await openOrder(page, s);
      const block = (i: number) => panel.getByTestId(`bloque-${s.coils[i]!.code}`);
      await expect(block(2).getByLabel(/Metros de la bobina 3/)).toHaveValue('20.000');

      await block(0)
        .getByLabel(/Metros de la bobina 1/)
        .fill('7');
      await block(0)
        .getByLabel(/Piezas de la bobina 1/)
        .fill('2');
      await block(0)
        .getByLabel(/kg consumidos de la bobina 1/)
        .fill('30');
      await block(1)
        .getByLabel(/Metros de la bobina 2/)
        .fill('9');
      await expect(block(2).getByLabel(/Metros de la bobina 3/)).toHaveValue('4.000');
      await expect(panel.getByText('Todo lo escrito está guardado')).toBeVisible({
        timeout: 30_000,
      });

      // En el servidor: dos filas, en orden de montaje. El llenado solo no viaja (D-575).
      await expect
        .poll(async () =>
          (await serverDrafts(api, s)).map((d) => [
            d.coilId,
            d.meters,
            d.piecesCount,
            d.consumedKg,
          ]),
        )
        .toEqual([
          [s.coils[0]!.id, '7.000', 2, '30.000'],
          [s.coils[1]!.id, '9.000', null, null],
        ]);
      // Nada de D-559 en el navegador.
      expect(
        await page.evaluate(() =>
          Object.keys(window.localStorage).filter((k) => k.startsWith('ayr:cc35:accesorio:')),
        ),
      ).toEqual([]);

      // Un refresco no pierde nada.
      await page.reload();
      const again = await openOrder(page, s);
      const blockAgain = (i: number) => again.getByTestId(`bloque-${s.coils[i]!.code}`);
      await expect(blockAgain(0).getByLabel(/Metros de la bobina 1/)).toHaveValue('7', {
        timeout: 60_000,
      });
      await expect(blockAgain(0).getByLabel(/Piezas de la bobina 1/)).toHaveValue('2');
      await expect(blockAgain(0).getByLabel(/kg consumidos de la bobina 1/)).toHaveValue('30');
      await expect(blockAgain(1).getByLabel(/Metros de la bobina 2/)).toHaveValue('9');
      await expect(blockAgain(2).getByLabel(/Metros de la bobina 3/)).toHaveValue('4.000');

      // Otro navegador (otro contexto, sin el almacenamiento del primero) ve lo mismo y cierra.
      const other = await newLoggedPage(browser);
      try {
        const otherPanel = await openOrder(other, s);
        const otherBlock = (i: number) => otherPanel.getByTestId(`bloque-${s.coils[i]!.code}`);
        await expect(otherBlock(0).getByLabel(/Metros de la bobina 1/)).toHaveValue('7', {
          timeout: 60_000,
        });
        await expect(otherBlock(1).getByLabel(/Metros de la bobina 2/)).toHaveValue('9');
        await expect(otherBlock(2).getByLabel(/Metros de la bobina 3/)).toHaveValue('4.000');
        await expect(otherBlock(2)).toContainText('Llenado solo · sin confirmar');

        await otherPanel.getByRole('button', { name: `Registrar y cerrar ${s.opCode}` }).click();
        await otherPanel
          .getByTestId('confirmar-llenado-solo')
          .getByRole('checkbox', { name: 'Confirmo que salieron' })
          .click();
        const preview = otherPanel.getByTestId('que-va-a-pasar');
        await expect(preview).toContainText(`${s.opCode} queda cerrada`, { timeout: 60_000 });
        await preview.getByRole('button', { name: 'Confirmar: registrar y cerrar' }).click();
        await expect
          .poll(
            async () =>
              (await getJson<ProductionOrderDto>(api, `/api/production/${s.opId}`)).status,
            { timeout: 60_000 },
          )
          .toBe('CLOSED');
      } finally {
        await other.context().close();
      }

      // Bobina 1: 7 m × 4.04 = 28.28 kg + 1.72 de despunte = 30. Bobina 2: 9 m = 36.36 kg y el
      // cierre se lleva el resto (3.64 kg) de despunte. Bobina 3: 4 m = 16.16 kg.
      expect((await balanceOf(api, 'COIL', s.coils[0]!.id)).qty).toBe('0.000');
      expect((await balanceOf(api, 'COIL', s.coils[2]!.id)).qty).toBe('983.840');
      expect((await balanceOf(api, 'PRODUCT', s.accessoryId)).qty).toBe('20.000');
      expect(await serverDrafts(api, s)).toEqual([]);
    } finally {
      await purgeRoofingTrail(api, s.trail);
    }
  });

  test('transición: lo que D-559 dejó en el navegador sube una vez al borrador y la clave local se borra; si el servidor ya tiene borrador, gana el servidor', async ({
    page,
  }) => {
    const s = await scenario(api);
    const key = `ayr:cc35:accesorio:${s.opId}`;
    try {
      await loginAsAdmin(page);
      // Lo que D-559 guardaba: lo escrito por bobina, con la clave del parte; un bloque ya
      // registrado (`sent`) no sube.
      await page.evaluate(
        ([k, value]) => {
          window.localStorage.setItem(k, value);
        },
        [
          key,
          JSON.stringify({
            [s.coils[0]!.id]: { meters: '6', pieces: '3', consumedKg: '', key: 'vieja' },
            [s.coils[1]!.id]: { meters: '5', pieces: '', consumedKg: '', sent: true },
          }),
        ] as const,
      );
      const panel = await openOrder(page, s);
      await expect
        .poll(async () =>
          (await serverDrafts(api, s)).map((d) => [d.coilId, d.meters, d.piecesCount]),
        )
        .toEqual([[s.coils[0]!.id, '6.000', 3]]);
      await expect.poll(() => page.evaluate((k) => window.localStorage.getItem(k), key)).toBeNull();
      await expect(
        panel.getByTestId(`bloque-${s.coils[0]!.code}`).getByLabel(/Metros de la bobina 1/),
      ).toHaveValue('6');

      // Con borrador en el servidor, una clave vieja que reaparezca no pisa nada y se borra.
      await page.evaluate(
        ([k, value]) => {
          window.localStorage.setItem(k, value);
        },
        [
          key,
          JSON.stringify({ [s.coils[0]!.id]: { meters: '1', pieces: '', consumedKg: '' } }),
        ] as const,
      );
      await page.reload();
      await openOrder(page, s);
      await expect.poll(() => page.evaluate((k) => window.localStorage.getItem(k), key)).toBeNull();
      expect((await serverDrafts(api, s)).map((d) => d.meters)).toEqual(['6.000']);
    } finally {
      await purgeRoofingTrail(api, s.trail);
    }
  });
});
