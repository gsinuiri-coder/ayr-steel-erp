import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  Decimal,
  businessToday,
  type DocumentProfitabilityDto,
  type SalesByMaterialDto,
} from '@ayr/shared';
import {
  adminApi,
  adminCredentials,
  createUser,
  getItems,
  getJson,
  postJson,
} from '../helpers/api';
import {
  createInvoice,
  dispatchOrder,
  invoiceBody,
  purgeInvoicingTrail,
  setupOrderScenario,
} from '../helpers/invoicing';
import { apiAs } from '../helpers/production';
import {
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  reportPieces,
  reservationsOf,
  roofingOrder,
  setupRoofingScenario,
} from '../helpers/roofing';
import { createCustomer } from '../helpers/sales';

/**
 * Correcciones 06 contra la base real.
 *
 * - **M0 (D-360):** la bobina se termina sola cuando una salida la deja en exactamente 0, sin
 *   kardex; 0,001 kg no la termina; montada en una OP se termina al cerrarla; la reversa de lo
 *   que la terminó la reabre.
 * - **M1 (D-361):** la rentabilidad de cada comprobante: cuadra con «Ventas por material», costea
 *   lo que no es de Coberturas Aluzinc por el despacho declarado, y un VENDEDOR no la ve.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Mueve kardex y factura: nunca contra producción (D-126).');
test.describe.configure({ timeout: 240_000 });

interface CoilDto {
  id: string;
  status: string;
  availableKg: string;
}

interface MovementRow {
  id: string;
  type: 'IN' | 'OUT' | 'ADJUST';
  qty: string;
  totalCost: string;
  refType: string;
}

const coilOf = (api: APIRequestContext, id: string) => getJson<CoilDto>(api, `/api/coils/${id}`);
const movementsOf = (api: APIRequestContext, id: string) =>
  getItems<MovementRow>(api, `/api/inventory/movements?itemType=COIL&itemId=${id}`);

function manualNumber(): { series: string; correlative: number } {
  return {
    series: `F9${String(Math.floor(Math.random() * 90) + 10)}`,
    correlative: Math.floor(Math.random() * 90_000) + 1_000,
  };
}

async function invoiceManual(
  api: APIRequestContext,
  input: {
    customerId: string;
    salesOrderId: string;
    items: { salesOrderItemId: string; qty: string }[];
  },
): Promise<{ id: string; number: string | null }> {
  const draft = await createInvoice(api, { docType: 'FACTURA', ...input });
  return postJson<{ id: string; number: string | null }>(
    api,
    `/api/invoicing/documents/${draft.id}/register-manual`,
    manualNumber(),
  );
}

test.describe('Correcciones 06', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('M0: la merma que deja la bobina en 0 la termina sin kardex; 0,001 kg no; anular la merma la reabre', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '300' });
    const other = await setupRoofingScenario(api, { weightKg: '300' });
    const trail = {
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
    try {
      // Deja 0,001 kg: sigue vigente.
      await postJson(api, `/api/coils/${other.coil.id}/scrap`, {
        qtyKg: '299.999',
        reason: 'Merma casi total (prueba E2E)',
      });
      const almost = await coilOf(api, other.coil.id);
      expect(almost.availableKg).toBe('0.001');
      expect(almost.status).toBe('OPEN');

      // Deja exactamente 0: se termina en la misma operación, y el único movimiento nuevo es la merma.
      const before = (await movementsOf(api, scenario.coil.id)).length;
      await postJson(api, `/api/coils/${scenario.coil.id}/scrap`, {
        qtyKg: '300',
        reason: 'Merma total (prueba E2E)',
      });
      const emptied = await coilOf(api, scenario.coil.id);
      expect(emptied.availableKg).toBe('0.000');
      expect(emptied.status).toBe('CLOSED');
      const after = await movementsOf(api, scenario.coil.id);
      expect(after.length).toBe(before + 1);
      const scrap = after.find((m) => m.refType === 'SCRAP')!;
      expect(after.some((m) => m.refType === 'CLOSE_ADJUSTMENT')).toBe(false);

      // La reversa de la merma que la terminó la reabre con sus kilos.
      await postJson(api, `/api/coils/scraps/${scrap.id}/cancel`, {
        reason: 'La merma era de otra bobina (prueba E2E)',
      });
      const reopened = await coilOf(api, scenario.coil.id);
      expect(reopened.status).toBe('OPEN');
      expect(reopened.availableKg).toBe('300.000');
    } finally {
      await purgeRoofingTrail(api, trail);
      await purgeRoofingTrail(api, {
        ...trail,
        supplierId: other.supplier.id,
        finishId: other.finish.id,
        colorId: other.color.id,
        productIds: [other.product.id],
        coilIds: [other.coil.id],
        purchaseIds: [other.purchaseId],
      });
    }
  });

  test('M0: montada en la OP no se termina al reportar; el cierre que la deja en 0 la termina y reabrir la OP la reabre', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '300' });
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
    try {
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: pieces([4, 2]),
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const reservation = (await reservationsOf(api, order.id))[0]!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];
      await mountCoil(api, op.id, { coilId: scenario.coil.id });
      await reportPieces(api, op.id, { pieces: pieces([4, 2]) });
      expect((await coilOf(api, scenario.coil.id)).status).toBe('OPEN');

      // Planta declara que se consumió el rollo entero: el despunte lo deja en 0 al cerrar.
      await postJson(api, `/api/production/roofing/${op.id}/close`, {
        consumedKg: '300.000',
        reason: 'Se consumió el rollo entero (prueba E2E)',
      });
      const closed = await coilOf(api, scenario.coil.id);
      expect(closed.availableKg).toBe('0.000');
      expect(closed.status).toBe('CLOSED');

      // Reabrir la OP devuelve el despunte y la bobina vuelve a estar vigente, sola.
      await postJson(api, `/api/production/roofing/${op.id}/reopen`, {
        reason: 'Se cerró con el consumo equivocado (prueba E2E)',
      });
      const back = await coilOf(api, scenario.coil.id);
      expect(back.status).toBe('OPEN');
      expect(new Decimal(back.availableKg).gt(0)).toBe(true);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('M1: la rentabilidad de la factura cuadra con Ventas por material, y un VENDEDOR no la ve', async ({
    baseURL,
    page,
  }) => {
    const scenario = await setupRoofingScenario(api, { weightKg: '900' });
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
    const documentIds: string[] = [];
    let seller: APIRequestContext | undefined;
    try {
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: pieces([4, 2]),
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const reservation = (await reservationsOf(api, order.id))[0]!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];
      await mountCoil(api, op.id, { coilId: scenario.coil.id });
      const reported = await reportPieces(api, op.id, { pieces: pieces([4, 2]) });
      const theoretical = reported.reports.reduce(
        (acc, r) => acc.plus(r.theoreticalKg),
        new Decimal(0),
      );
      await postJson(api, `/api/production/roofing/${op.id}/close`, {
        consumedKg: theoretical.times('1.03').toFixed(3),
      });
      const item = order.items[0]!;
      const invoice = await invoiceManual(api, {
        customerId: customer.id,
        salesOrderId: order.id,
        items: [{ salesOrderItemId: item.id, qty: item.qty }],
      });
      documentIds.push(invoice.id);

      const profit = await getJson<DocumentProfitabilityDto>(
        api,
        `/api/reports/documents/${invoice.id}/profitability`,
      );
      expect(profit.applies).toBe(true);
      expect(profit.lines).toHaveLength(1);
      const line = profit.lines[0]!;
      expect(line.costBasis).toBe('COIL_KG');
      expect(line.status).toBe('COMPLETE');
      expect(line.metersSold).toBe('8.000');

      // Cuadre: lo que el comprobante aporta a Ventas por material (su color, su día).
      const today = businessToday();
      const byMaterial = await getJson<SalesByMaterialDto>(
        api,
        `/api/reports/sales-by-material?from=${today}&to=${today}&color=${encodeURIComponent(scenario.color.name)}`,
      );
      expect(profit.materialTotal.salesPen).toBe(byMaterial.total.salesPen);
      expect(profit.materialTotal.costPen).toBe(byMaterial.total.costPen);
      expect(profit.materialTotal.realKg).toBe(byMaterial.total.realKg);
      // Las columnas nuevas por ML de Ventas por material.
      expect(byMaterial.total.pricePerMeterPen).not.toBeNull();
      expect(byMaterial.rows[0]!.costPerUnitPen).toBe(line.costPerUnitPen);

      // Un VENDEDOR: 403 en la ruta.
      const user = await createUser(api, 'VENDEDOR');
      seller = await apiAs(baseURL!, user);
      const denied = await seller.get(`/api/reports/documents/${invoice.id}/profitability`);
      expect(denied.status()).toBe(403);

      // Y en pantalla, el administrador ve la sección con el aviso.
      const { email, password } = adminCredentials();
      await page.goto('/login');
      await page.getByLabel('Correo electrónico').fill(email);
      await page.getByLabel('Contraseña', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Ingresar' }).click();
      await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
      await page.goto(`/comprobantes/${invoice.id}`);
      const section = page.getByTestId('rentabilidad');
      await expect(section).toBeVisible({ timeout: 60_000 });
      await expect(section.getByTestId('aviso-costeo')).toContainText(
        'Ventas por material y la Rentabilidad de cada factura costean con los kilos de bobina consumidos.',
      );
      await expect(section.getByTestId('rentabilidad-fila')).toHaveCount(1);
      await expect(section.getByTestId('rentabilidad-fila')).toContainText('Completo');
    } finally {
      await seller?.dispose();
      await purgeInvoicingTrail(api, { documentIds }).catch(() => undefined);
      await purgeRoofingTrail(api, trail);
    }
  });

  test('M1: bobina entera de otra línea: el costo de su salida por el despacho declarado; la venta la termina', async () => {
    const scenario = await setupOrderScenario(api, { coilKg: '500' });
    const documentIds: string[] = [];
    try {
      const { order, item, customer, coil } = scenario;
      const dispatch = await dispatchOrder(api, {
        salesOrderId: order.id,
        items: [{ salesOrderItemId: item.id, qty: item.qty, weightKg: item.qty }],
      });
      // D-170 por la regla común de D-360: vendida entera y en 0, terminada.
      expect((await coilOf(api, coil.id)).status).toBe('CLOSED');
      // Sin asiento de cierre: el kardex de la bobina es su entrada y la salida de la venta.
      const kardex = await movementsOf(api, coil.id);
      expect(kardex.map((m) => [m.type, m.refType])).toEqual([
        ['IN', 'PURCHASE'],
        ['OUT', 'SALE'],
      ]);
      // La reserva COIL de la venta se consume antes de la salida y de la terminación: no es
      // una anomalía. Una sola terminación, por el despacho, y ningún aviso de anomalía.
      const audit = await getJson<{ items: { after: Record<string, unknown> | null }[] }>(
        api,
        `/api/audit?entityType=coils&entityId=${coil.id}`,
      );
      const auto = audit.items.filter((e) => e.after?.autoTerminated !== undefined);
      expect(auto).toHaveLength(1);
      expect(auto[0]!.after).toEqual(
        expect.objectContaining({
          status: 'CLOSED',
          autoTerminated: { kind: 'DISPATCH', refId: dispatch.id },
          closedByDispatch: expect.stringMatching(/^DES-\d{6}$/) as unknown,
        }),
      );

      // D-213: el comprobante declara el despacho que cubre; sin eso no hay costo (D-205).
      const draft = await postJson<{ id: string }>(api, '/api/invoicing/documents', {
        ...invoiceBody({
          docType: 'FACTURA',
          customerId: customer.id,
          salesOrderId: order.id,
          items: [{ salesOrderItemId: item.id, qty: item.qty }],
        }),
        dispatchId: dispatch.id,
      });
      documentIds.push(draft.id);
      const invoice = await postJson<{ id: string }>(
        api,
        `/api/invoicing/documents/${draft.id}/register-manual`,
        manualNumber(),
      );

      const profit = await getJson<DocumentProfitabilityDto>(
        api,
        `/api/reports/documents/${invoice.id}/profitability`,
      );
      const line = profit.lines[0]!;
      expect(line.costBasis).toBe('DISPATCH_SALE');
      expect(line.status).toBe('COMPLETE');
      expect(line.costBasisDetail).toMatch(/^DES-\d{6}$/);
      const sale = (await movementsOf(api, coil.id)).filter((m) => m.refType === 'SALE');
      const cost = sale.reduce(
        (acc, m) => acc.plus(new Decimal(m.totalCost).times(m.type === 'OUT' ? 1 : -1)),
        new Decimal(0),
      );
      expect(line.costPen).toBe(cost.toFixed(4));
      // No es de Coberturas Aluzinc: no suma a Ventas por material.
      expect(profit.materialTotal.salesPen).toBe('0.0000');
    } finally {
      await purgeInvoicingTrail(api, { documentIds }).catch(() => undefined);
    }
  });
});
