import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createUser, getItems, getJson, postJson } from '../helpers/api';
import {
  apiAs,
  balanceOf,
  postExpectingError,
  type ProductionOrderDto,
} from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  buyRoofingCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrderLines,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * cc29 (M3, D-466) — el sobrante físico de una bobina terminada con el kardex en 0.
 *
 * El hueco: la bobina se consumió entera en el kardex y se terminó. Planta encuentra material.
 * El único camino para declararlo era reabrirla y volver a terminarla declarando el peso físico
 * (D-164: ese ajuste es un ingreso de sobrante); pero montarla desde planta la reabre (D-193) y
 * reabrir **revierte** el último ajuste de cierre: el sobrante sale y el montaje falla por falta de
 * kilos.
 *
 * Crea compras, bobinas y producción: nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea compras, bobinas y producción: nunca contra producción (D-126).');
test.describe.configure({ timeout: 240_000 });

interface MovementDto {
  id: string;
  refType: string;
  refId: string | null;
  type: string;
  qty: string;
  unitCost: string;
  reversalOfId: string | null;
  reversedById: string | null;
}

async function movementsOf(api: APIRequestContext, coilId: string): Promise<MovementDto[]> {
  return getItems<MovementDto>(api, `/api/inventory/movements?itemType=COIL&itemId=${coilId}`);
}

/** Una bobina de 500 kg consumida entera en el kardex (merma de RF-17) y terminada en 0. */
async function setup(api: APIRequestContext) {
  const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
  const spent = await buyRoofingCoil(api, {
    supplierId: scenario.supplier.id,
    finishId: scenario.finish.id,
    colorId: scenario.color.id,
    weightKg: '500',
  });
  await postJson(api, `/api/coils/${spent.coil.id}/scrap`, {
    qtyKg: '500.000',
    reason: 'E2E cc29: el kardex da la bobina por consumida',
  });
  // Sin saldo, la bobina se termina sola (sin ajuste de cierre: no había nada que liquidar).
  expect(await getJson<{ status: string }>(api, `/api/coils/${spent.coil.id}`)).toMatchObject({
    status: 'CLOSED',
  });
  expect((await balanceOf(api, 'COIL', spent.coil.id)).qty).toBe('0.000');

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
    coilIds: [scenario.coil.id, spent.coil.id],
    purchaseIds: [scenario.purchaseId, spent.purchaseId],
    productionOrderIds: [opId],
    orderIds: [order.id],
    quotationIds: [quotation.id],
  };
  return { coilId: spent.coil.id, productId: scenario.product.id, order, opId, trail };
}

test.describe('cc29 — sobrante de una bobina terminada en 0 (D-466)', () => {
  test('el hueco: el sobrante declarado al terminarla se revierte al montarla, y el montaje falla', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const { coilId, opId, trail } = await setup(api);
    try {
      // Reabrirla y terminarla de nuevo declarando lo que hay: 120 kg de sobrante (D-164).
      await postJson(api, `/api/coils/${coilId}/status`, {
        status: 'OPEN',
        reason: 'E2E cc29: planta encontró material',
      });
      await postJson(api, `/api/coils/${coilId}/status`, {
        status: 'CLOSED',
        physicalKg: '120.000',
        reason: 'E2E cc29: quedan 120 kg en el rollo',
      });
      expect((await balanceOf(api, 'COIL', coilId)).qty).toBe('120.000');

      // Montarla la reabre (D-193), y reabrir revierte ese sobrante: no quedan kilos que montar.
      const refused = await postExpectingError(api, `/api/production/roofing/${opId}/coils`, {
        coilId,
        reopenCoilIds: [coilId],
        reopenReason: 'E2E cc29: se monta el sobrante',
      });
      expect(refused.status).toBe(400);
      expect(refused.message).toMatch(/no tiene kilos disponibles|peso físico/);
      // Todo o nada: el rechazo deshace la reapertura y el sobrante sigue en el kardex.
      expect((await balanceOf(api, 'COIL', coilId)).qty).toBe('120.000');
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('el arreglo: montarla pide el peso físico, el sobrante entra apuntando al montaje y bajarla lo deshace', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const { coilId, productId, order, opId, trail } = await setup(api);
    try {
      // Planta la ve entre las terminadas, con el kardex en 0 y pidiendo el peso físico.
      const options = await getJson<
        { coilId: string; status: string; availableKg: string; needsPhysicalKg: boolean }[]
      >(
        api,
        `/api/production/roofing/coils?productId=${productId}&reservationId=${order.reservations[0]!.id}&includeClosed=true`,
      );
      expect(options.find((c) => c.coilId === coilId)).toMatchObject({
        status: 'CLOSED',
        availableKg: '0.000',
        needsPhysicalKg: true,
      });

      const before = (await movementsOf(api, coilId)).length;
      const reopen = { coilId, reopenCoilIds: [coilId], reopenReason: 'E2E cc29: quedan 120 kg' };
      // Sin peso físico: el rechazo dice qué falta, y nada se movió.
      const missing = await postExpectingError(
        api,
        `/api/production/roofing/${opId}/coils`,
        reopen,
      );
      expect(missing.message).toContain('declara su peso físico');
      // Más de lo que la bobina pesó al entrar: no.
      const tooMuch = await postExpectingError(api, `/api/production/roofing/${opId}/coils`, {
        ...reopen,
        physicalKg: '500.001',
      });
      expect(tooMuch.message).toContain('un rollo no puede tener más material del que ingresó');
      expect(await movementsOf(api, coilId)).toHaveLength(before);

      // El supervisor de planta la monta declarando 120 kg.
      const supervisor = await createUser(api, 'SUPERVISOR_PLANTA');
      const plant = await apiAs(baseURL!, supervisor);
      const mounted = await postJson<ProductionOrderDto>(
        plant,
        `/api/production/roofing/${opId}/coils`,
        { ...reopen, physicalKg: '120.000' },
      );
      const consumption = mounted.consumptions.find(
        (c) => c.coilId === coilId && c.releasedAt === null,
      );
      expect(consumption).toMatchObject({ assignedKg: '120.000' });
      expect((await balanceOf(api, 'COIL', coilId)).qty).toBe('120.000');
      const surplus = (await movementsOf(api, coilId)).find(
        (m) => m.refType === 'CLOSE_ADJUSTMENT' && m.type === 'IN',
      );
      // El sobrante de D-164, apuntando al montaje (no a la bobina), con el costo del sobrante.
      expect(surplus).toMatchObject({ qty: '120.000', refId: consumption!.id });
      expect(Number(surplus!.unitCost)).toBeGreaterThan(0);

      // Bajarla sin usarla deshace el sobrante y la bobina vuelve a quedar terminada en 0.
      await postJson(api, `/api/production/roofing/${opId}/coils/${consumption!.id}/release`);
      expect((await balanceOf(api, 'COIL', coilId)).qty).toBe('0.000');
      const after = await movementsOf(api, coilId);
      expect(after.some((m) => m.reversalOfId === surplus!.id)).toBe(true);
      expect(await getJson<{ status: string }>(api, `/api/coils/${coilId}`)).toMatchObject({
        status: 'CLOSED',
      });
      await plant.dispose();
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });
});
