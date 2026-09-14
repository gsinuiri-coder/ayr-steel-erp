import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getItems, getJson, postJson } from '../helpers/api';
import { openQueuedOrder } from '../helpers/ui';
import { balanceOf, postExpectingError, type ProductionOrderDto } from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  buyRoofingCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrderLines,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * D-193 (F8-S3/M5) — reabrir una bobina cerrada desde el modal de montar.
 *
 * Lo que protege: una cerrada **se ve** y se puede elegir, pero montarla pasa por un paso
 * explícito que dice qué ajuste del cierre se revierte; sin esa confirmación el API la rechaza y
 * nada toca el kardex. Reabrir es un asiento compensatorio del `CLOSE_ADJUSTMENT` (D-164): el
 * original sigue en el kardex, anulado por su reversa, nunca editado ni borrado.
 *
 * Escenario: la bobina A (2 000 kg) cubre el pedido; la B (500 kg) se cierra declarando que
 * quedan 400 kg, así que el cierre saca 100 kg como faltante. Reabrirla los devuelve: 500 kg.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea compras, bobinas y producción: nunca contra producción (D-126).');
test.describe.configure({ timeout: 240_000 });

interface MovementDto {
  id: string;
  refType: string;
  type: string;
  qty: string;
  reversalOfId: string | null;
}

async function loginAsAdmin(page: Page) {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

async function setup(api: APIRequestContext) {
  const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
  const closed = await buyRoofingCoil(api, {
    supplierId: scenario.supplier.id,
    finishId: scenario.finish.id,
    colorId: scenario.color.id,
    weightKg: '500',
  });
  const shut = await postJson<{ status: string; availableKg: string }>(
    api,
    `/api/coils/${closed.coil.id}/status`,
    { status: 'CLOSED', physicalKg: '400', reason: 'E2E: quedaban 400 kg en el rollo' },
  );
  expect(shut).toMatchObject({ status: 'CLOSED', availableKg: '400.000' });

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
    coilIds: [scenario.coil.id, closed.coil.id],
    purchaseIds: [scenario.purchaseId, closed.purchaseId],
    productionOrderIds: [opId],
    orderIds: [order.id],
    quotationIds: [quotation.id],
  };
  return { scenario, closed, order, opId, trail };
}

async function movementsOf(api: APIRequestContext, coilId: string): Promise<MovementDto[]> {
  return getItems<MovementDto>(api, `/api/inventory/movements?itemType=COIL&itemId=${coilId}`);
}

test.describe('D-193 — reabrir una bobina cerrada para montarla', () => {
  test('por API: se ofrece con su ajuste; sin confirmar se rechaza sin tocar nada; confirmando se revierte el ajuste y se monta', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const { scenario, closed, order, opId, trail } = await setup(api);
    try {
      const reservationId = order.reservations[0]!.id;
      const withoutClosed = await getJson<{ coilId: string }[]>(
        api,
        `/api/production/roofing/coils?productId=${scenario.product.id}&reservationId=${reservationId}`,
      );
      expect(withoutClosed.some((c) => c.coilId === closed.coil.id)).toBe(false);

      const options = await getJson<
        {
          coilId: string;
          status: string;
          availableKg: string;
          closeAdjustment: { kind: string; qtyKg: string } | null;
        }[]
      >(
        api,
        `/api/production/roofing/coils?productId=${scenario.product.id}&reservationId=${reservationId}&includeClosed=true`,
      );
      expect(options.find((c) => c.coilId === closed.coil.id)).toMatchObject({
        status: 'CLOSED',
        closeAdjustment: { kind: 'SHORTAGE', qtyKg: '100.000' },
        availableKg: '500.000',
      });
      const movementsBefore = await movementsOf(api, closed.coil.id);

      // Sin confirmación explícita: 400 y el kardex no se movió.
      const refused = await postExpectingError(api, `/api/production/roofing/${opId}/coils`, {
        coilId: closed.coil.id,
      });
      expect(refused.message).toMatch(/está cerrada: para montarla hay que confirmar/);
      expect(await movementsOf(api, closed.coil.id)).toHaveLength(movementsBefore.length);
      // Y confirmar sin motivo tampoco pasa el schema.
      const noReason = await postExpectingError(api, `/api/production/roofing/${opId}/coils`, {
        coilId: closed.coil.id,
        reopenCoilIds: [closed.coil.id],
      });
      expect(noReason.status).toBe(400);

      const mounted = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${opId}/coils`,
        {
          coilId: closed.coil.id,
          reopenCoilIds: [closed.coil.id],
          reopenReason: 'La bobina tenía material: se reabre para esta orden',
        },
      );
      expect(mounted.status).toBe('IN_PROGRESS');
      expect(mounted.consumptions.find((c) => c.releasedAt === null)).toMatchObject({
        coilId: closed.coil.id,
        assignedKg: '500.000',
      });

      const coil = await getJson<{ status: string; availableKg: string }>(
        api,
        `/api/coils/${closed.coil.id}`,
      );
      expect(coil.status).toBe('OPEN');
      expect((await balanceOf(api, 'COIL', closed.coil.id)).qty).toBe('500.000');

      // Append-only: el ajuste original sigue ahí, y hay UN movimiento nuevo que lo compensa.
      const after = await movementsOf(api, closed.coil.id);
      expect(after).toHaveLength(movementsBefore.length + 1);
      const adjustment = after.find((m) => m.refType === 'CLOSE_ADJUSTMENT' && !m.reversalOfId);
      expect(adjustment).toMatchObject({ type: 'OUT', qty: '100.000' });
      expect(after.some((m) => m.reversalOfId === adjustment!.id)).toBe(true);
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('por pantalla: la cerrada aparece aparte, el paso de confirmación dice qué ajuste revierte, «Volver» no toca nada y confirmar la monta', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const { closed, order, opId, trail } = await setup(api);
    try {
      const op = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      const movementsBefore = await movementsOf(api, closed.coil.id);

      await loginAsAdmin(page);
      await page.goto(`/planta?pedido=${order.id}`);
      await expect(page.getByRole('heading', { name: `Producir ${order.code}` })).toBeVisible({
        timeout: 60_000,
      });
      // F8-S3c/M1: la orden ya es un chip desde que se entra; abrirla la selecciona.
      await openQueuedOrder(page, op.code);
      const panel = page.getByRole('tabpanel', { name: op.code });
      await panel.getByRole('button', { name: `Buscar una bobina para ${op.code}` }).click();
      const modal = page.getByRole('dialog');

      // La cerrada no se mezcla con las libres.
      await modal.getByLabel('Filtrar opciones').fill(closed.coil.code);
      await expect(
        modal.getByRole('button', { name: `Montar ${closed.coil.code}`, exact: true }),
      ).toHaveCount(0);
      await modal.getByRole('button', { name: /Ver bobinas cerradas/ }).click();
      const closedTable = modal.getByRole('table', { name: 'Bobinas cerradas' });
      const row = closedTable.getByRole('row').filter({ hasText: closed.coil.code });
      await expect(row).toContainText('−100.000 kg');
      await expect(row).toContainText('500.000 kg');

      // Paso explícito, y «Volver» no mueve nada.
      await row.getByRole('button', { name: `Reabrir y montar ${closed.coil.code}` }).click();
      await expect(modal.getByRole('alert')).toContainText(
        `${closed.coil.code} cerrada con ajuste de 100.000 kg (faltante) — reabrirla revierte el ajuste`,
      );
      const confirm = modal.getByRole('button', {
        name: `Confirmar: reabrir y montar ${closed.coil.code}`,
      });
      await expect(confirm).toBeDisabled();
      await modal.getByRole('button', { name: 'Volver' }).click();
      await expect(modal.getByRole('alert')).toHaveCount(0);
      expect(await movementsOf(api, closed.coil.id)).toHaveLength(movementsBefore.length);

      // Confirmar con motivo.
      await closedTable
        .getByRole('row')
        .filter({ hasText: closed.coil.code })
        .getByRole('button', { name: `Reabrir y montar ${closed.coil.code}` })
        .click();
      await modal.getByLabel(`Motivo para reabrir ${closed.coil.code}`).fill('Queda material útil');
      await confirm.click();
      await expect(modal).toHaveCount(0);

      await expect(
        panel.getByRole('button', { name: `Bajar la bobina ${closed.coil.code} de ${op.code}` }),
      ).toBeVisible();
      expect((await balanceOf(api, 'COIL', closed.coil.id)).qty).toBe('500.000');
      expect(await movementsOf(api, closed.coil.id)).toHaveLength(movementsBefore.length + 1);
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });
});
