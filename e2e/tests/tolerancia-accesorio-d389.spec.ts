import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canonicalAccessorySku } from '@ayr/shared';
import { adminApi, createUser, getJson, postJson, type CreatedUser } from '../helpers/api';
import { apiAs, ROLE_PASSWORD, today } from '../helpers/production';
import {
  mountCoil,
  purgeRoofingTrail,
  reservationsOf,
  setupRoofingScenario,
} from '../helpers/roofing';
import { createCustomer } from '../helpers/sales';
import { confirmPlantClose } from '../helpers/ui';

/**
 * D-389 — el accesorio también entra con la casilla al pasar la tolerancia del 1 %.
 *
 * Bobina de 1 000 kg con 4,04 kg/m (1 000 mm × 0,50 mm × densidad 8 × 1,01): rinde 247,5 m. Un
 * reporte de 255 m equivale a 1 030,2 kg teóricos, un 2,94 % más que lo montado (redondeado hacia arriba). La tarjeta del
 * accesorio (reporte directo, sin borrador) muestra el aviso con la casilla y reenvía. Con
 * «Reportar y cerrar» el rechazo habla de «motivo», como el del despunte: el diálogo del despunte
 * **no** se abre (era un bucle en la revisión de cc20).
 *
 * Crea compras, pedidos y órdenes: nunca contra producción (D-126, regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos de planta: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 300_000 });

const METERS_OVER = '255.000';

interface CoilState {
  status: string;
  availableKg: string;
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

test.describe('D-389 — accesorio fuera de tolerancia', () => {
  let api: APIRequestContext;
  let supervisor: CreatedUser;
  let supervisorApi: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
    supervisor = await createUser(api, 'SUPERVISOR_PLANTA');
    supervisorApi = await apiAs(baseURL!, supervisor);
  });

  test.afterAll(async () => {
    await supervisorApi.dispose();
    await api.dispose();
  });

  /** Un accesorio, su pedido confirmado con faltante y la bobina de 1 000 kg montada en su OP. */
  async function accessoryOrder() {
    const s = await setupRoofingScenario(api, { weightKg: '1000' });
    const customer = await createCustomer(api);
    const accessory = await postJson<{ id: string }>(api, '/api/catalog', {
      businessLineId: s.product.businessLineId,
      sku: canonicalAccessorySku(s.product.thicknessMm ?? '0.50', s.color.code),
      name: 'Accesorio E2E D-389',
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
      // cc38 (D-573): el pedido encarga los mismos metros que se registran, así la orden puede cerrar.
      items: [{ productId: accessory.id, qty: METERS_OVER, unitPricePen: '60' }],
    });
    const order = await postJson<{ id: string }>(
      api,
      `/api/sales/quotations/${quotation.id}/confirm`,
      { confirmShortfall: true, shortfallReason: 'E2E D-389: la bobina rinde menos que el pedido' },
    );
    const opId = (await reservationsOf(api, order.id)).find(
      (r) => r.productionOrderId,
    )?.productionOrderId;
    expect(opId, 'confirmar no dejó la OP en cola').toBeTruthy();
    await mountCoil(api, opId!, { coilId: s.coil.id });
    const op = await getJson<{ id: string; code: string }>(api, `/api/production/${opId!}`);
    const trail = {
      supplierId: s.supplier.id,
      finishId: s.finish.id,
      colorId: s.color.id,
      productIds: [s.product.id, accessory.id],
      coilIds: [s.coil.id],
      purchaseIds: [s.purchaseId],
      productionOrderIds: [op.id],
      orderIds: [order.id],
      quotationIds: [quotation.id],
    };
    return { op, coilId: s.coil.id, trail };
  }

  test('API: sin casilla pide la casilla; un supervisor la marca y entra topado en el saldo', async () => {
    const { op, coilId, trail } = await accessoryOrder();
    try {
      const report = (body: Record<string, unknown>) =>
        supervisorApi.post(`/api/production/roofing/${op.id}/report`, {
          data: { meters: METERS_OVER, ...body, idempotencyKey: randomUUID() },
        });
      const without = await report({});
      expect(without.status()).toBe(400);
      const body = (await without.json()) as {
        code?: string;
        excess?: { excessPct: string; severe: boolean };
      };
      expect(body.code).toBe('TOLERANCE_OVERRIDE_REQUIRED');
      expect(body.excess).toMatchObject({ excessPct: '2.94', severe: false });

      const heavier = await report({ toleranceOverride: { reason: 'HEAVIER_COIL' } });
      expect(heavier.status()).toBe(400);

      const accepted = await report({ toleranceOverride: { reason: 'LIGHTER_COIL' } });
      expect(accepted.ok(), await accepted.text()).toBe(true);
      expect((await getJson<CoilState>(api, `/api/coils/${coilId}`)).availableKg).toBe('0.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('pantalla (modelo M, cc35): la casilla aparece en el bloque de la bobina, sin ella no se registra, y con ella cierra', async ({
    page,
  }) => {
    const { op, coilId, trail } = await accessoryOrder();
    try {
      await login(page, supervisor.email, ROLE_PASSWORD);
      await page.goto(`/planta?op=${op.id}`);
      const panel = page.locator(`#panel-${op.id}`);
      // Un accesorio no tiene plan de corte: banda «Avance» y sin «Ajustar el plan».
      await expect(panel.getByText('Avance', { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(panel.getByRole('button', { name: /Ajustar el plan/ })).toHaveCount(0);
      // cc38 (D-575): el bloque llega lleno con los metros del pedido y sin confirmar; se confirma.
      await expect(panel.getByLabel(/Metros de la bobina 1/)).toHaveValue(METERS_OVER, {
        timeout: 60_000,
      });
      await panel.getByRole('button', { name: /^Sí, salió así en la bobina 1/ }).click();

      const block = panel.getByTestId('tolerance-override');
      await expect(block).toContainText('2.94 %', { timeout: 60_000 });
      const registerAndClose = panel.getByRole('button', { name: `Registrar y cerrar ${op.code}` });
      const preview = panel.getByTestId('que-va-a-pasar');
      // Sin la casilla no se manda nada.
      await registerAndClose.click();
      await expect(preview).toHaveCount(0);
      await expect(page.getByRole('dialog', { name: 'Cerrar con despunte alto' })).toHaveCount(0);

      await block
        .getByRole('checkbox', { name: /Confirmar la bobina 1 .* fuera de tolerancia/ })
        .click();
      await block
        .getByRole('combobox', { name: /Motivo de la bobina 1/ })
        .selectOption('LIGHTER_COIL');
      await registerAndClose.click();
      // cc27 (D-453): el resumen avisa de la fila fuera de tolerancia antes de cerrar.
      await expect(preview).toContainText('Fuera de tolerancia', { timeout: 60_000 });
      await preview.getByRole('button', { name: 'Confirmar: registrar y cerrar' }).click();
      await expect(page.getByText(`${op.code}: producción registrada y orden cerrada`)).toBeVisible(
        { timeout: 60_000 },
      );
      await expect(page.getByRole('dialog', { name: 'Cerrar con despunte alto' })).toHaveCount(0);

      expect(await getJson<CoilState>(api, `/api/coils/${coilId}`)).toMatchObject({
        availableKg: '0.000',
        status: 'CLOSED',
      });
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
