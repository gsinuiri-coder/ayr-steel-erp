import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  Decimal,
  businessToday,
  canonicalAccessorySku,
  type SalesByMaterialDto,
  type SalesMarginDto,
} from '@ayr/shared';
import { adminApi, adminCredentials, getItems, getJson, postJson } from '../helpers/api';
import { createInvoice, dispatchOrder, purgeInvoicingTrail } from '../helpers/invoicing';
import { createCustomer } from '../helpers/sales';
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

/**
 * D-354 — «Ventas por material» contra la base real: que el SQL encuentre lo que el armado
 * (probado sin base en `sales-by-material.service.spec.ts`) espera.
 *
 * - peso real y costo = los movimientos de kardex de la bobina que produjo para la línea
 *   (reportes + despunte al cerrar la OP, D-089);
 * - la venta del comprobante cuadra con la de «Ventas y margen»;
 * - una línea facturada sin producción va a «No trazable» con su motivo;
 * - una bobina vendida entera trae los kilos y el costo de su salida por despacho.
 *
 * Cada escenario crea su propio color, así que filtrar por color aísla sus filas de lo que
 * dejen otros tests en la misma base.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Mueve kardex y factura: nunca contra producción (D-126).');
test.describe.configure({ timeout: 180_000 });

interface MovementRow {
  type: 'IN' | 'OUT' | 'ADJUST';
  qty: string;
  totalCost: string;
  refType: string;
}

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

function byMaterial(api: APIRequestContext, qs: string): Promise<SalesByMaterialDto> {
  const today = businessToday();
  return getJson<SalesByMaterialDto>(
    api,
    `/api/reports/sales-by-material?from=${today}&to=${today}&${qs}`,
  );
}

async function marginDocumentSales(api: APIRequestContext, documentId: string): Promise<string> {
  const today = businessToday();
  const margin = await getJson<SalesMarginDto>(
    api,
    `/api/reports/sales-margin?from=${today}&to=${today}`,
  );
  const doc = margin.orders.flatMap((o) => o.documents).find((d) => d.id === documentId);
  expect(doc, 'el comprobante tiene que estar en Ventas y margen').toBeDefined();
  return doc!.salesPen;
}

/** Kilos y costo netos que salieron de la bobina por producción y despunte (y por venta). */
async function coilOutflow(
  api: APIRequestContext,
  coilId: string,
  refTypes: string[],
): Promise<{ kg: Decimal; cost: Decimal }> {
  const rows = await getItems<MovementRow>(
    api,
    `/api/inventory/movements?itemType=COIL&itemId=${coilId}`,
  );
  let kg = new Decimal(0);
  let cost = new Decimal(0);
  for (const m of rows.filter((r) => refTypes.includes(r.refType))) {
    const sign = m.type === 'OUT' ? 1 : -1;
    if (m.type !== 'ADJUST') kg = kg.plus(new Decimal(m.qty).times(sign));
    cost = cost.plus(new Decimal(m.totalCost).times(sign));
  }
  return { kg, cost };
}

test.describe('D-354 — Ventas por material', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('cobertura producida con despunte: peso real y costo del kardex de la bobina; venta = Ventas y margen', async ({
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
      // Despunte real del 3 %: sale como SCRAP con `refId` = la OP (D-089).
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

      const report = await byMaterial(api, `color=${encodeURIComponent(scenario.color.name)}`);
      expect(report.rows).toHaveLength(1);
      const row = report.rows[0]!;
      expect(row.kind).toBe('COBERTURA');
      expect(row.metersSold).toBe('8.000');

      const outflow = await coilOutflow(api, scenario.coil.id, ['PRODUCTION', 'SCRAP']);
      expect(row.realKg).toBe(outflow.kg.toFixed(3));
      expect(row.costPen).toBe(outflow.cost.toFixed(4));
      expect(row.coils.map((c) => c.code)).toEqual([scenario.coil.code]);

      // D-369: el teórico sale de la bobina —8 m × 1000 mm × 0.50 mm × 8.0000 ÷ 1000—, sin el
      // 1 % de D-165 que sí lleva el kilo que planta descontó.
      expect(row.theoreticalKg).toBe('32.000');
      expect(theoretical.toFixed(3)).not.toBe('32.000');
      // D-370: la bobina lleva sus comprobantes, con los kilos y metros que se llevó cada uno.
      expect(row.coils[0]!.documents).toEqual([
        expect.objectContaining({
          documentId: invoice.id,
          customerName: customer.name,
          kg: outflow.kg.toFixed(3),
          meters: '8.000',
        }),
      ]);

      // Cuadre con Ventas y margen, por comprobante.
      expect(row.salesPen).toBe(await marginDocumentSales(api, invoice.id));

      // En pantalla: sin el botón «Bobinas usadas»; la fila abre el desglose y la bobina, sus
      // comprobantes, con el número enlazado al detalle.
      const { email, password } = adminCredentials();
      await page.goto('/login');
      await page.getByLabel('Correo electrónico').fill(email);
      await page.getByLabel('Contraseña', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Ingresar' }).click();
      await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
      await page.goto(`/reportes/ventas-material?color=${encodeURIComponent(scenario.color.name)}`);
      const filas = page.getByTestId('fila-material');
      await expect(filas).toHaveCount(1, { timeout: 60_000 });
      await expect(page.getByRole('button', { name: 'Bobinas usadas' })).toHaveCount(0);
      await filas.first().click();
      const dialog = page.getByTestId('desglose-material');
      await expect(dialog).toBeVisible();
      const bobina = dialog.getByTestId('bobina-material');
      await expect(bobina).toHaveCount(1);
      await expect(bobina).toContainText(scenario.coil.code);
      await bobina
        .getByRole('button', { name: `Ver comprobantes de ${scenario.coil.code}` })
        .click();
      const docs = dialog.getByTestId('comprobantes-bobina');
      await expect(docs).toContainText(customer.name);
      await expect(
        docs.getByRole('link', { name: invoice.number ?? 'Sin número' }),
      ).toHaveAttribute('href', `/comprobantes/${invoice.id}`);
    } finally {
      await purgeInvoicingTrail(api, { documentIds }).catch(() => undefined);
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-369: accesorio reportado en metros (sin largos): teórico de la bobina, no cero', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '900' });
    const customer = await createCustomer(api);
    const accessory = await postJson<{ id: string }>(api, '/api/catalog', {
      businessLineId: scenario.product.businessLineId,
      sku: canonicalAccessorySku(scenario.product.thicknessMm ?? '0.50', scenario.color.code),
      name: 'Accesorio E2E D-369',
      unit: 'MTR',
      source: 'MANUFACTURED',
      listPricePen: '30',
      finishId: scenario.product.finishId,
      colorId: scenario.product.colorId,
      thicknessMm: scenario.product.thicknessMm,
      widthMm: scenario.product.widthMm,
      roofingKind: 'ACCESORIO',
    });
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id, accessory.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };
    const documentIds: string[] = [];
    try {
      const quotation = await postJson<{ id: string }>(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: businessToday(),
        items: [{ productId: accessory.id, qty: '25.000', unitPricePen: '60' }],
      });
      trail.quotationIds = [quotation.id];
      const order = await postJson<{ id: string; items: { id: string; qty: string }[] }>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds = [order.id];
      const reservation = (await reservationsOf(api, order.id))[0]!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];
      await mountCoil(api, op.id, { coilId: scenario.coil.id });
      // D-343: el accesorio se reporta en metros; el reporte no lleva detalle de largos.
      await postJson(api, `/api/production/roofing/${op.id}/report`, {
        meters: '25.000',
        piecesCount: 4,
      });
      const item = order.items[0]!;
      const invoice = await invoiceManual(api, {
        customerId: customer.id,
        salesOrderId: order.id,
        items: [{ salesOrderItemId: item.id, qty: item.qty }],
      });
      documentIds.push(invoice.id);

      const report = await byMaterial(
        api,
        `kind=ACCESORIO&color=${encodeURIComponent(scenario.color.name)}`,
      );
      expect(report.rows).toHaveLength(1);
      const row = report.rows[0]!;
      // 25 m × 1000 mm × 0.50 mm × 8.0000 ÷ 1000, sin el 1 %.
      expect(row.theoreticalKg).toBe('100.000');
      expect(row.coils[0]).toMatchObject({ meters: '25.000', theoreticalKg: '100.000' });
    } finally {
      await purgeInvoicingTrail(api, { documentIds }).catch(() => undefined);
      await purgeRoofingTrail(api, trail);
    }
  });

  test('línea facturada sin producción: «No trazable», sin estimar', async () => {
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
    try {
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: pieces([3, 1]),
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const item = order.items[0]!;
      const invoice = await invoiceManual(api, {
        customerId: customer.id,
        salesOrderId: order.id,
        items: [{ salesOrderItemId: item.id, qty: item.qty }],
      });
      documentIds.push(invoice.id);

      const report = await byMaterial(api, `color=${encodeURIComponent(scenario.color.name)}`);
      expect(report.rows).toEqual([]);
      const mine = report.untraceable.filter((u) => u.documentId === invoice.id);
      expect(mine.map((u) => [u.reason, u.metersSold])).toEqual([['SIN_PRODUCCION', '3.000']]);
      expect(mine[0]!.salesPen).toBe(await marginDocumentSales(api, invoice.id));
    } finally {
      await purgeInvoicingTrail(api, { documentIds }).catch(() => undefined);
      await purgeRoofingTrail(api, trail);
    }
  });

  test('bobina entera de Coberturas Aluzinc: kilos y costo de su salida por despacho', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '500' });
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
    try {
      const quotation = await postJson<{ id: string }>(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: businessToday(),
        items: [{ saleCoilId: scenario.coil.id, qty: '500.000', unitPricePen: '8.0000' }],
      });
      const order = await postJson<{
        id: string;
        items: { id: string; qty: string; productId: string }[];
      }>(api, `/api/sales/quotations/${quotation.id}/confirm`, {});
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const item = order.items[0]!;
      await dispatchOrder(api, {
        salesOrderId: order.id,
        items: [{ salesOrderItemId: item.id, qty: item.qty, weightKg: item.qty }],
      });
      const invoice = await invoiceManual(api, {
        customerId: customer.id,
        salesOrderId: order.id,
        items: [{ salesOrderItemId: item.id, qty: item.qty }],
      });
      documentIds.push(invoice.id);

      const report = await byMaterial(
        api,
        `kind=BOBINA&color=${encodeURIComponent(scenario.color.name)}`,
      );
      expect(report.rows).toHaveLength(1);
      const row = report.rows[0]!;
      const outflow = await coilOutflow(api, scenario.coil.id, ['SALE']);
      expect(row.realKg).toBe('500.000');
      expect(row.theoreticalKg).toBe('500.000');
      expect(row.costPen).toBe(outflow.cost.toFixed(4));
      expect(row.salesPen).toBe(await marginDocumentSales(api, invoice.id));
    } finally {
      await purgeInvoicingTrail(api, { documentIds }).catch(() => undefined);
      await purgeRoofingTrail(api, trail);
    }
  });
});
