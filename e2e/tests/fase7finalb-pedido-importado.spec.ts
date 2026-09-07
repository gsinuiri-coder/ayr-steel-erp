import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson } from '../helpers/api';
import {
  batchErrors,
  confirmImport,
  createdEntityIds,
  documentNumber,
  importCorrelative,
  importSeriesCode,
  patchImportGroup,
  previewSalesHistory,
  salesHistoryRows,
  annulImportedTrail,
} from '../helpers/imports';
import { movementsOf, type ProductionOrderDto } from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  metersOf,
  pieces,
  purgeRoofingTrail,
  reservationsOf,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * Sesión 7-final-B — el pedido de un comprobante importado (D-141).
 *
 * Lo que estos dos casos protegen es **la línea que separa las dos mitades del toggle**, que
 * es la única decisión nueva de la sesión:
 *
 * - un documento marcado **entregado** crea un pedido cáscara y no toca **nada** más: ni el
 *   ledger de reservas, ni el kardex, ni la cola de producción;
 * - uno marcado **pendiente** con una línea a medida recorre el flujo normal completo:
 *   reserva genérica por los kilos teóricos (D-134) y orden de producción en cola, **sin
 *   bobina montada** — montar es de planta (D-086).
 *
 * Lo que sigue después de la OP —montar, drenar la reserva, cerrar— ya lo cubre
 * `fase7final-m1` y no se repite acá: una OP nacida de una importación es exactamente la
 * misma fila que una nacida de `/planta`, y probarla dos veces solo habría duplicado el
 * costo de la suite sin cubrir una rama más.
 *
 * Escribe comprobantes, pedidos y producción: nunca contra producción (regla dura 9, D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Importa comprobantes y crea pedidos y producción: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 180_000 });

/** Lo mínimo del pedido que estos casos leen. */
interface OrderView {
  id: string;
  code: string;
  status: string;
  origin: string;
  importedDocumentId: string | null;
  importedDocumentNumber: string | null;
  queueStatus: string | null;
  items: { qty: string; unit: string; description: string }[];
}

async function documentOf(
  api: APIRequestContext,
  documentId: string,
): Promise<{ id: string; number: string | null; salesOrderId: string | null; status: string }> {
  return getJson(api, `/api/invoicing/documents/${documentId}`);
}

test.describe('7-final-B — el pedido de un comprobante importado (D-141)', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('caso 1: un documento ENTREGADO deja un pedido cumplido y enlazado, con el kardex y el ledger intactos', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const series = importSeriesCode();
    const correlative = importCorrelative();
    const number = documentNumber(series, correlative);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      orderIds: [],
    };
    const documentIds: string[] = [];

    try {
      // El estado del kardex **antes** de importar: es contra esto que se compara, y no
      // contra cero, porque la compra de la bobina del escenario ya dejó su entrada.
      const movementsBefore = await movementsOf(api, 'COIL', scenario.coil.id);
      expect(movementsBefore).toHaveLength(1);

      // 15 m a S/ 30 = S/ 450 de valor de venta, S/ 81 de IGV, S/ 531 de precio de venta.
      const rows = salesHistoryRows({
        series,
        correlative,
        customerText: `${customer.docNumber} - ${customer.name}`,
        // Sin columna `ENTREGA`: el default del adaptador es ENTREGADO, que es lo que este
        // caso prueba — la elección conservadora es la que no toca inventario.
        lines: [
          {
            sku: scenario.product.sku,
            unit: 'MTR',
            qty: '15.000',
            netPen: '450.00',
            igvPen: '81.00',
            grossPen: '531.00',
          },
        ],
      });

      const preview = await previewSalesHistory(api, rows);
      expect(batchErrors(preview), 'el documento entregado entra sin errores').toEqual([]);

      const confirmed = await confirmImport(api, preview.id);
      const ids = createdEntityIds(confirmed);
      expect(ids, 'el comprobante entero se confirma como una sola entidad').toHaveLength(1);
      documentIds.push(ids[0]!);

      // --- el enlace bidireccional -----------------------------------------
      const document = await documentOf(api, ids[0]!);
      expect(document.number).toBe(number);
      expect(document.salesOrderId, 'el comprobante apunta a su pedido').not.toBeNull();
      const order = await getJson<OrderView>(api, `/api/sales/orders/${document.salesOrderId!}`);
      trail.orderIds = [order.id];
      expect(order.importedDocumentId, 'y el pedido apunta al comprobante').toBe(document.id);
      expect(order.importedDocumentNumber).toBe(number);

      // --- el pedido cáscara -------------------------------------------------
      expect(order.status, 'nace en el estado terminal, ya atendido').toBe('FULFILLED');
      expect(order.origin).toBe('IMPORTED');
      // Líneas espejo: la misma cantidad y la misma unidad que el comprobante.
      expect(order.items).toHaveLength(1);
      expect(order.items[0]).toMatchObject({ qty: '15.000', unit: 'MTR' });

      // --- cero efectos: la aserción que da sentido al caso ------------------
      expect(await reservationsOf(api, order.id), 'cero reservas en el ledger').toEqual([]);
      expect(order.queueStatus, 'y nada en la cola de producción').toBeNull();
      const movementsAfter = await movementsOf(api, 'COIL', scenario.coil.id);
      expect(movementsAfter, 'cero movimientos de kardex sobre la bobina').toHaveLength(
        movementsBefore.length,
      );
      // El producto terminado nunca existió en el kardex: importar una venta ya entregada
      // no puede inventarle una entrada ni una salida.
      const productMovements = await movementsOf(api, 'PRODUCT', scenario.product.id);
      expect(productMovements, 'ni un movimiento sobre el producto').toEqual([]);
    } finally {
      await annulImportedTrail(api, documentIds);
      await purgeRoofingTrail(api, trail);
    }
  });

  test('caso 2: un documento PENDIENTE a medida deja un pedido confirmado, su reserva genérica y la OP en cola sin bobina montada', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const series = importSeriesCode();
    const correlative = importCorrelative();
    const number = documentNumber(series, correlative);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      orderIds: [],
      productionOrderIds: [],
    };
    const documentIds: string[] = [];

    try {
      const movementsBefore = await movementsOf(api, 'COIL', scenario.coil.id);

      // 3 planchas de 5 m = 15 m. Con 1 000 mm de ancho, 0.50 mm y densidad 8.0 son
      // 4 kg por metro lineal: **60.000 kg** teóricos, el mismo número que M1 comprueba
      // desde la cotización.
      const rows = pieces([5, 3]);
      expect(metersOf(rows)).toBe('15.000');

      const sheet = salesHistoryRows({
        series,
        correlative,
        customerText: `${customer.docNumber} - ${customer.name}`,
        lines: [
          {
            sku: scenario.product.sku,
            unit: 'MTR',
            qty: '15.000',
            netPen: '450.00',
            igvPen: '81.00',
            grossPen: '531.00',
            // D-141: el desglose de largos es opcional; acá se manda para que el plan de
            // corte de la OP nazca completo y se pueda comprobar.
            piecesText: '5.00x3',
          },
        ],
      });

      const preview = await previewSalesHistory(api, sheet);
      expect(batchErrors(preview), 'la planilla entra limpia como entregada').toEqual([]);

      // El toggle es del **documento**: una sola llamada marca sus líneas y revalida el
      // grupo entero contra el material disponible.
      const pendingPreview = await patchImportGroup(api, preview.id, number, {
        fulfillment: 'PENDING',
      });
      expect(
        batchErrors(pendingPreview),
        'hay 500 kg de esa bobina y el pedido pide 60: entra como pendiente',
      ).toEqual([]);
      expect(pendingPreview.rows.every((r) => r.status === 'VALID')).toBe(true);

      const confirmed = await confirmImport(api, pendingPreview.id);
      const ids = createdEntityIds(confirmed);
      expect(ids).toHaveLength(1);
      documentIds.push(ids[0]!);

      const document = await documentOf(api, ids[0]!);
      const order = await getJson<OrderView>(api, `/api/sales/orders/${document.salesOrderId!}`);
      trail.orderIds = [order.id];

      // --- el pedido vivo ----------------------------------------------------
      expect(order.status, 'nace confirmado, no atendido').toBe('CONFIRMED');
      expect(order.origin).toBe('IMPORTED');
      expect(order.importedDocumentNumber).toBe(number);

      // --- la reserva genérica (D-134) ---------------------------------------
      const reservations = await reservationsOf(api, order.id);
      expect(reservations).toHaveLength(1);
      expect(reservations[0]).toMatchObject({
        itemType: 'RAW_MATERIAL',
        qty: '60.000',
        unit: 'KGM',
        status: 'ACTIVE',
      });
      // Promete el **agregado**, no el rollo: cuál bobina lo cumple es decisión de planta.
      expect(reservations[0]!.itemId).not.toBe(scenario.coil.id);

      // --- la OP en cola, enlazada y sin bobina ------------------------------
      const productionOrderId = reservations[0]!.productionOrderId;
      expect(productionOrderId, 'la importación dejó la orden creada').not.toBeNull();
      trail.productionOrderIds = [productionOrderId!];
      const productionOrder = await getJson<ProductionOrderDto>(
        api,
        `/api/production/${productionOrderId!}`,
      );
      expect(productionOrder.status, 'en su estado inicial: en cola').toBe('DRAFT');
      expect(productionOrder.kind).toBe('ROOFING');
      expect(productionOrder.salesOrderId).toBe(order.id);
      expect(
        productionOrder.consumptions,
        'sin bobina montada: montar es del dueño en planta (D-086)',
      ).toEqual([]);
      expect(productionOrder.assignedKg).toBe('0.000');
      // El plan de corte salió de los largos de la previsualización.
      expect(productionOrder.items).toEqual([{ lineNumber: 1, lengthMm: '5000.00', qty: 3 }]);

      // --- y el kardex sigue sin moverse -------------------------------------
      // Reservar es una promesa comercial, no un hecho físico (D-054): la bobina sigue
      // entera hasta que la OP monte y reporte.
      const movementsAfter = await movementsOf(api, 'COIL', scenario.coil.id);
      expect(movementsAfter).toHaveLength(movementsBefore.length);
    } finally {
      await annulImportedTrail(api, documentIds);
      await purgeRoofingTrail(api, trail);
    }
  });

  test('caso 3: el mismo documento pendiente SIN los largos entra igual y deja la orden con el plan vacío', async () => {
    // Es el caso realista: ningún export de facturación desglosa las planchas, así que el
    // archivo del dueño nunca va a traer la columna. Los kilos prometidos no dependen del
    // desglose —salen de `metros × espesor × ancho × densidad`— y el plan de corte lo llena
    // planta antes de rolar (D-084).
    const scenario = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const series = importSeriesCode();
    const correlative = importCorrelative();
    const number = documentNumber(series, correlative);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      orderIds: [],
      productionOrderIds: [],
    };
    const documentIds: string[] = [];

    try {
      const preview = await previewSalesHistory(
        api,
        salesHistoryRows({
          series,
          correlative,
          customerText: `${customer.docNumber} - ${customer.name}`,
          fulfillment: 'PENDING',
          lines: [
            {
              sku: scenario.product.sku,
              unit: 'MTR',
              qty: '15.000',
              netPen: '450.00',
              igvPen: '81.00',
              grossPen: '531.00',
              // Sin `piecesText`: la columna queda vacía, que es como sale del Excel real.
            },
          ],
        }),
      );
      expect(batchErrors(preview), 'la falta de largos no bloquea el pendiente').toEqual([]);

      const confirmed = await confirmImport(api, preview.id);
      documentIds.push(createdEntityIds(confirmed)[0]!);
      const document = await documentOf(api, documentIds[0]!);
      const order = await getJson<OrderView>(api, `/api/sales/orders/${document.salesOrderId!}`);
      trail.orderIds = [order.id];
      expect(order.status).toBe('CONFIRMED');
      expect(order.importedDocumentNumber).toBe(number);

      // Los kilos son exactamente los mismos que con el desglose: 15 m × 4 kg/m.
      const reservations = await reservationsOf(api, order.id);
      expect(reservations).toHaveLength(1);
      expect(reservations[0]).toMatchObject({
        itemType: 'RAW_MATERIAL',
        qty: '60.000',
        status: 'ACTIVE',
      });

      const productionOrderId = reservations[0]!.productionOrderId;
      expect(productionOrderId).not.toBeNull();
      trail.productionOrderIds = [productionOrderId!];
      const productionOrder = await getJson<ProductionOrderDto>(
        api,
        `/api/production/${productionOrderId!}`,
      );
      expect(productionOrder.status).toBe('DRAFT');
      expect(productionOrder.consumptions).toEqual([]);
      // Lo único que cambia respecto del caso 2: el plan nace vacío y lo completa planta.
      expect(productionOrder.items).toEqual([]);
    } finally {
      await annulImportedTrail(api, documentIds);
      await purgeRoofingTrail(api, trail);
    }
  });
});
