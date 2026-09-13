import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import { openQueuedOrder } from '../helpers/ui';
import { balanceOf, postExpectingError, type ProductionOrderDto } from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  buyRoofingCoil,
  coilOptions,
  pieces,
  purgeRoofingTrail,
  quoteAndOrderLines,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * D-192 (F8-S3/M4) — montar varias bobinas a la vez, con el peso inicial a la vista.
 *
 * - por API: `coilIds` monta todas en una transacción (todo o nada), y el borrador de reportes
 *   (D-191) dice contra qué bobina va cada fila;
 * - por pantalla: el modal muestra el peso inicial, se eligen dos con casillas, el workspace las
 *   muestra como filas y cada una se baja por separado.
 *
 * Aritmética: 4.04 kg por metro (D-165).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea compras, bobinas y producción: nunca contra producción (D-126).');
test.describe.configure({ timeout: 240_000 });

async function loginAsAdmin(page: Page) {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test.describe('D-192 — montar varias bobinas', () => {
  test('por API: coilIds monta todas o ninguna, y el borrador reparte las filas por bobina', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '100' });
    const second = await buyRoofingCoil(api, {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      weightKg: '100',
    });
    const customer = await createCustomer(api);
    // Plan de 40 m = 161.6 kg: no entra en una bobina de 100 kg, sí en dos.
    const { quotation, order } = await quoteAndOrderLines(api, {
      customerId: customer.id,
      lines: [{ productId: scenario.product.id, rows: pieces([4, 10]) }],
    });
    const opId = order.reservations[0]!.productionOrderId!;
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id, second.coil.id],
      purchaseIds: [scenario.purchaseId, second.purchaseId],
      productionOrderIds: [opId],
      orderIds: [order.id],
      quotationIds: [quotation.id],
    };

    try {
      // El selector trae el peso inicial de cada rollo.
      const options = await coilOptions(api, scenario.product.id, order.reservations[0]!.id);
      const mine = options.filter((o) => [scenario.coil.id, second.coil.id].includes(o.coilId));
      expect(mine.map((o) => (o as { weightKg?: string }).weightKg)).toEqual([
        '100.000',
        '100.000',
      ]);

      // Todo o nada: con un id que no sirve, no se monta ninguna.
      const bad = await postExpectingError(api, `/api/production/roofing/${opId}/coils`, {
        coilIds: [scenario.coil.id, randomUUID()],
      });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      const untouched = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      expect(untouched.consumptions.filter((c) => c.releasedAt === null)).toHaveLength(0);
      expect(untouched.status).toBe('DRAFT');

      const mounted = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${opId}/coils`,
        { coilIds: [scenario.coil.id, second.coil.id] },
      );
      expect(mounted.status).toBe('IN_PROGRESS');
      expect(mounted.consumptions.filter((c) => c.releasedAt === null)).toHaveLength(2);

      // Con dos bobinas, cada fila del borrador dice de cuál sale.
      const drafts = `/api/production/roofing/${opId}/drafts`;
      const noCoil = await postExpectingError(api, drafts, { pieces: pieces([4, 5]) });
      expect(noCoil.message).toMatch(/varias bobinas montadas/);
      await postJson(api, drafts, { coilId: scenario.coil.id, pieces: pieces([4, 5]) }); // 80.8
      const rows = await postJson<{ coilCode: string }[]>(api, drafts, {
        coilId: second.coil.id,
        pieces: pieces([4, 5]),
      });
      expect(rows.map((r) => r.coilCode)).toEqual([scenario.coil.code, second.coil.code]);

      const closed = await postJson<ProductionOrderDto>(api, `${drafts}/commit`, {
        close: true,
        idempotencyKey: randomUUID(),
      });
      expect(closed.status).toBe('CLOSED');
      // 80.8 kg de cada rollo: cada fila salió de la bobina que nombraba.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('19.200');
      expect((await balanceOf(api, 'COIL', second.coil.id)).qty).toBe('19.200');
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('por pantalla: peso inicial en el modal, dos bobinas elegidas con casillas, filas en el workspace y bajar una sola', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '1500' });
    const second = await buyRoofingCoil(api, {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      weightKg: '1200',
    });
    const customer = await createCustomer(api);
    const { quotation, order } = await quoteAndOrderLines(api, {
      customerId: customer.id,
      lines: [{ productId: scenario.product.id, rows: pieces([4, 10]) }],
    });
    const opId = order.reservations[0]!.productionOrderId!;
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id, second.coil.id],
      purchaseIds: [scenario.purchaseId, second.purchaseId],
      productionOrderIds: [opId],
      orderIds: [order.id],
      quotationIds: [quotation.id],
    };

    try {
      const op = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      await loginAsAdmin(page);
      await page.goto(`/planta?pedido=${order.id}`);
      await expect(page.getByRole('heading', { name: `Producir ${order.code}` })).toBeVisible({
        timeout: 60_000,
      });
      // F8-S3b/M2: la orden no iniciada está en la cola del pedido; abrirla la fija como pestaña.
      await openQueuedOrder(page, op.code);
      const panel = page.getByRole('tabpanel', { name: op.code });

      await panel.getByRole('button', { name: `Buscar una bobina para ${op.code}` }).click();
      const modal = page.getByRole('dialog');
      await expect(modal.getByText(`Bobinas para ${op.code}`)).toBeVisible();
      await expect(modal.getByRole('columnheader', { name: 'Peso inicial' })).toBeVisible();
      const rowA = modal.getByRole('row').filter({ hasText: scenario.coil.code });
      const rowB = modal.getByRole('row').filter({ hasText: second.coil.code });
      await expect(rowA).toContainText('1,500.000 kg');
      await expect(rowB).toContainText('1,200.000 kg');

      await modal.getByRole('checkbox', { name: `Elegir ${scenario.coil.code}` }).click();
      await modal.getByRole('checkbox', { name: `Elegir ${second.coil.code}` }).click();
      await modal
        .getByRole('button', { name: `Montar las 2 bobinas elegidas en ${op.code}` })
        .click();
      await expect(modal).toHaveCount(0);

      // Las dos, como filas.
      await expect(panel.getByText('Bobinas montadas (2)')).toBeVisible();
      const releaseA = panel.getByRole('button', {
        name: `Bajar la bobina ${scenario.coil.code} de ${op.code}`,
      });
      const releaseB = panel.getByRole('button', {
        name: `Bajar la bobina ${second.coil.code} de ${op.code}`,
      });
      await expect(releaseA).toBeEnabled();
      await expect(releaseB).toBeEnabled();

      // Con dos montadas, el editor pide elegir de cuál sale la fila.
      await expect(panel.getByText('Indica de qué bobina salieron.')).toBeVisible();
      await panel
        .getByRole('button', { name: `Reportar desde la bobina ${second.coil.code}` })
        .click();
      await panel.getByLabel('Planchas del largo 1').fill('3');
      await panel.getByRole('button', { name: `Agregar al borrador de ${op.code}` }).click();
      const draft = panel.getByRole('table', { name: `Borrador de ${op.code}` });
      await expect(draft.getByRole('row').filter({ hasText: '3 × 4.00 m' })).toContainText(
        second.coil.code,
      );

      // Bajar una sola: la que no tiene filas en el borrador se baja; la otra no.
      await expect(releaseB).toBeDisabled();
      await releaseA.click();
      await expect(panel.getByText('Bobina montada', { exact: true })).toBeVisible();
      await expect(releaseB).toBeVisible();
      const after = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      expect(after.consumptions.filter((c) => c.releasedAt === null).map((c) => c.coilId)).toEqual([
        second.coil.id,
      ]);
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });
});
