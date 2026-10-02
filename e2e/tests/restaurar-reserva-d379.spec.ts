import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays } from '@ayr/shared';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import { releaseReservationLegacyForTest } from '../helpers/db';
import { createInvoice, purgeInvoicingTrail, type FiscalDocumentDto } from '../helpers/invoicing';
import { live, movementsOf, postExpectingError, today } from '../helpers/production';
import {
  mountCoil,
  pieces,
  purgeRoofingTrail,
  reportPieces,
  reservationsOf,
  roofingOrder,
  ROOFING_LINE,
  setupRoofingScenario,
  type RoofingScenario,
} from '../helpers/roofing';
import { createCustomer, createQuotationWithLines, type SalesOrderDto } from '../helpers/sales';

/**
 * **D-379 — la reserva de lo fabricado de una línea contra pedido.**
 *
 * El caso real es FFA1-00001382: la reserva de producto terminado de su línea se liberó a mano y
 * la línea quedó sin despacho posible, porque una línea que se fabrica contra el pedido solo sale
 * de esa reserva (D-088/D-171). D-379 cierra las dos mitades:
 *
 * 1. esa reserva ya **no se libera a mano** mientras cubra lo fabricado sin despachar;
 * 2. la que ya se liberó (el estado previo a D-379) **se restaura** desde la línea del pedido, y
 *    el comprobante la enlaza desde su tarjeta de despacho. Después se despacha desde ahí con la
 *    fecha elegida y el despacho queda enlazado al comprobante.
 *
 * Escribe compras, bobinas, pedidos, producción, comprobantes y despachos: nunca contra
 * producción (D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea compras, pedidos, OP, comprobantes y despachos: nunca contra producción (D-126).',
);

test.describe.configure({ timeout: 300_000 });

/** Cuatro planchas de 3 m: 12 m, 48.48 kg de bobina a 4.04 kg/m. */
const SHEETS = 4;
const VALUE_PER_METER = '60.0000';

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

interface Produced {
  scenario: RoofingScenario;
  order: SalesOrderDto;
  productReservationId: string;
  trail: Parameters<typeof purgeRoofingTrail>[1];
}

/** Cotiza, confirma, rola y reporta: la línea queda con su reserva de producto activa. */
async function produceOrder(api: APIRequestContext): Promise<Produced> {
  const scenario = await setupRoofingScenario(api, { weightKg: '1000', pieceLengthMm: '3000' });
  const customer = await createCustomer(api);
  const trail: Parameters<typeof purgeRoofingTrail>[1] = {
    supplierId: scenario.supplier.id,
    finishId: scenario.finish.id,
    colorId: scenario.color.id,
    productIds: [scenario.product.id],
    coilIds: [scenario.coil.id],
    purchaseIds: [scenario.purchaseId],
    productionOrderIds: [],
    orderIds: [],
    quotationIds: [],
  };
  const quotation = await createQuotationWithLines(api, {
    customerId: customer.id,
    businessLine: ROOFING_LINE,
    items: [
      { productId: scenario.product.id, qty: String(SHEETS), valuePerMeterPen: VALUE_PER_METER },
    ],
  });
  trail.quotationIds = [quotation.id];
  const order = await postJson<SalesOrderDto>(
    api,
    `/api/sales/quotations/${quotation.id}/confirm`,
    {},
  );
  trail.orderIds = [order.id];
  const raw = (await reservationsOf(api, order.id))[0]!;
  const op = await roofingOrder(api, raw.id);
  trail.productionOrderIds = [op.id];
  await mountCoil(api, op.id, { coilId: scenario.coil.id });
  await reportPieces(api, op.id, { pieces: pieces([3, SHEETS]) });
  await postJson(api, `/api/production/roofing/${op.id}/close`, {});
  const product = (await reservationsOf(api, order.id)).find((r) => r.itemType === 'PRODUCT');
  expect(product, 'la producción no abrió la reserva de producto (D-088)').toBeDefined();
  expect(product).toMatchObject({ status: 'ACTIVE', qty: `${String(SHEETS)}.000` });
  return { scenario, order, productReservationId: product!.id, trail };
}

test.describe('D-379 — reserva de lo fabricado de una línea contra pedido', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('producido el pedido, liberar a mano la reserva de lo fabricado queda bloqueado', async () => {
    const produced = await produceOrder(api);
    try {
      const rejected = await postExpectingError(
        api,
        `/api/sales/reservations/${produced.productReservationId}/release`,
        { reason: 'Intento de liberar lo fabricado (D-379)' },
      );
      expect(rejected.status).toBe(400);
      expect(rejected.message).toContain('se fabrica contra el pedido');
      expect(rejected.message).toContain(
        'Despacha la línea, revierte la producción o anula el pedido',
      );
      // La reserva sigue viva y no se puede «restaurar» lo que nunca se liberó.
      const still = (await reservationsOf(api, produced.order.id)).find(
        (r) => r.id === produced.productReservationId,
      );
      expect(still).toMatchObject({ status: 'ACTIVE', restorable: false });
    } finally {
      await purgeRoofingTrail(api, produced.trail);
    }
  });

  test('reserva liberada antes de D-379: restaurar desde el comprobante y despachar con la fecha elegida', async ({
    page,
  }) => {
    const produced = await produceOrder(api);
    const documentIds: string[] = [];
    const dispatchIds: string[] = [];
    try {
      const line = produced.order.items[0]!;
      // El comprobante manual del pedido, emitido antes de producir (como el 1382).
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: produced.order.customerId,
        salesOrderId: produced.order.id,
        issueDate: addDays(today(), -3),
        items: [{ salesOrderItemId: line.id, qty: line.qty }],
      });
      documentIds.push(draft.id);
      const invoice = await postJson<FiscalDocumentDto>(
        api,
        `/api/invoicing/documents/${draft.id}/register-manual`,
        { series: 'F906', correlative: Number(String(Date.now()).slice(-7)) },
      );

      // El estado previo a D-379: la reserva de lo fabricado, liberada a mano.
      await releaseReservationLegacyForTest(produced.productReservationId, 'mala rerva (E2E)');
      const released = (await reservationsOf(api, produced.order.id)).find(
        (r) => r.id === produced.productReservationId,
      );
      expect(released).toMatchObject({ status: 'RELEASED', restorable: true });
      // La foto del kardex **antes** de restaurar: la restauración no tiene que moverlo.
      const beforeRestore = await movementsOf(api, 'PRODUCT', produced.scenario.product.id);

      // El comprobante dice por qué la línea no sale y enlaza la acción.
      await loginAsAdmin(page);
      await page.goto(`/comprobantes/${invoice.id}`);
      const card = page.getByTestId('dispatch-at-issue-date');
      await expect(card).toContainText('No se despacha');
      await expect(card).toContainText('se fabrica contra el pedido');
      await expect(
        card.getByRole('button', { name: 'Despachar en la fecha seleccionada' }),
      ).toHaveCount(0);
      await card
        .getByTestId('dispatch-restore-reservation')
        .getByRole('link', { name: 'Restaurar reserva' })
        .click();

      // El enlace abre el pedido con el diálogo listo.
      await expect(page).toHaveURL(new RegExp(`/pedidos/${produced.order.id}`));
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('Restaurar la reserva de');
      await dialog.getByLabel('Motivo').fill('Reponer la reserva liberada por error (E2E D-379)');
      await dialog.getByRole('button', { name: 'Restaurar reserva', exact: true }).click();
      await expect(
        page.getByText('Reserva restaurada: la línea ya se puede despachar'),
      ).toBeVisible();

      const restored = (await reservationsOf(api, produced.order.id)).find(
        (r) => r.id === produced.productReservationId,
      );
      expect(restored).toMatchObject({
        status: 'ACTIVE',
        qty: `${String(SHEETS)}.000`,
        restorable: false,
      });
      // La restauración no movió el kardex: los mismos movimientos que antes de restaurar.
      const afterRestore = await movementsOf(api, 'PRODUCT', produced.scenario.product.id);
      expect(afterRestore.map((m) => m.id)).toEqual(beforeRestore.map((m) => m.id));
      const beforeDispatch = live(afterRestore);

      // De vuelta en el comprobante, la línea ya sale: se despacha con la fecha elegida.
      const chosen = today();
      await page.goto(`/comprobantes/${invoice.id}`);
      await expect(card).toContainText('Sale del almacén');
      await card.getByLabel('Fecha de despacho').fill(chosen);
      await card.getByRole('button', { name: 'Despachar en la fecha seleccionada' }).click();
      await expect(page.getByText(/1 línea\(s\) despachada\(s\)/)).toBeVisible();

      const order = await getJson<SalesOrderDto>(api, `/api/sales/orders/${produced.order.id}`);
      expect(order.status).toBe('FULFILLED');
      const linked = await getJson<{ dispatches: { id: string; dispatchDate: string }[] }>(
        api,
        `/api/dispatches/at-issue-date/${invoice.id}/linked`,
      );
      // El despacho quedó enlazado al comprobante (D-364) y con la fecha elegida.
      expect(linked.dispatches).toHaveLength(1);
      expect(linked.dispatches[0]!.dispatchDate).toBe(chosen);
      dispatchIds.push(linked.dispatches[0]!.id);

      const after = live(await movementsOf(api, 'PRODUCT', produced.scenario.product.id));
      const out = after.filter((m) => !beforeDispatch.some((b) => b.id === m.id));
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        type: 'OUT',
        qty: `${String(SHEETS)}.000`,
        refId: linked.dispatches[0]!.id,
        operationDate: chosen,
      });
      expect(beforeDispatch.length).toBe(after.length - 1);
    } finally {
      await purgeInvoicingTrail(api, { documentIds, dispatchIds });
      await purgeRoofingTrail(api, produced.trail);
    }
  });
});
