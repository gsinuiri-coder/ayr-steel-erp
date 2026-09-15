import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getItems, postJson } from '../helpers/api';
import { deactivateTrail, setupScenario, type ProductionOrderDto } from '../helpers/production';
import { dispatchOrder, fiscalEmissionAllowed, FISCAL_EMISSION_REASON } from '../helpers/invoicing';
import {
  closeSessionQuietly,
  openCashSession,
  posSell,
  setupPosStock,
  type CashSessionDto,
} from '../helpers/pos';
import { createCustomer, createDirectOrder, purgeSalesTrail } from '../helpers/sales';
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
 * F8-S5/M1 — el kardex enlaza su referencia a la pantalla que corresponde (D-205).
 *
 * `InventoryService.findMovements` (único lugar que arma el DTO) resuelve `refTargetType` /
 * `refTargetId` a partir de `(refType, refId)`. Lo que este archivo prueba es esa resolución
 * contra los movimientos reales, no la UI: la UI solo arma un `<Link>` con esos dos campos
 * (kardex-view.tsx, bobina-detalle-view.tsx), y no tiene lógica propia que pueda estar mal.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Mueve kardex de punta a punta: nunca contra producción (D-126).');
test.describe.configure({ timeout: 180_000 });

interface MovementRow {
  id: string;
  type: string;
  refType: string;
  refId: string | null;
  refTargetType: string | null;
  refTargetId: string | null;
  invoiceId: string | null;
}

async function movementsOf(
  api: APIRequestContext,
  itemType: 'COIL' | 'PRODUCT',
  itemId: string,
): Promise<MovementRow[]> {
  return getItems<MovementRow>(
    api,
    `/api/inventory/movements?itemType=${itemType}&itemId=${itemId}`,
  );
}

test.describe('F8-S5/M1 — el kardex enlaza su referencia (D-205)', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('PURCHASE enlaza a la compra y CUTTING a la orden de corte', async () => {
    const s = await setupScenario(api);
    try {
      const motherMovements = await movementsOf(api, 'COIL', s.mother.id);
      const purchaseMovement = motherMovements.find((m) => m.refType === 'PURCHASE');
      expect(purchaseMovement?.refTargetType).toBe('purchase');
      expect(purchaseMovement?.refTargetId).toBe(s.purchaseId);

      const cuttingOut = motherMovements.find((m) => m.refType === 'CUTTING');
      expect(cuttingOut?.refTargetType).toBe('cutting');
      expect(cuttingOut?.refTargetId).toBe(s.cuttingOrderId);

      const stripMovements = await movementsOf(api, 'COIL', s.strips[0]!.id);
      const stripIn = stripMovements.find((m) => m.refType === 'CUTTING');
      expect(stripIn?.refTargetType).toBe('cutting');
      expect(stripIn?.refTargetId).toBe(s.cuttingOrderId);
    } finally {
      await deactivateTrail(api, {
        cuttingOrderId: s.cuttingOrderId,
        motherId: s.mother.id,
        purchaseId: s.purchaseId,
        supplierId: s.supplier.id,
        finish: s.finish,
        productId: s.product.id,
      });
    }
  });

  test('PRODUCTION enlaza a la orden cuando `refId` es un reporte (el caso frecuente)', async () => {
    const s = await setupScenario(api);
    let opId = '';
    try {
      const created = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
        targetPieces: 10,
        notes: 'E2E D-205 — reporte',
      });
      opId = created.id;
      await postJson(api, `/api/production/${opId}/consume`, { coilId: s.strips[0]!.id });
      await postJson(api, `/api/production/${opId}/report`, { pieces: 10 });

      const productMovements = await movementsOf(api, 'PRODUCT', s.product.id);
      const productionIn = productMovements.find((m) => m.refType === 'PRODUCTION');
      expect(productionIn, 'el reporte tiene que dejar una entrada PRODUCTION').toBeDefined();
      expect(productionIn?.refTargetType).toBe('productionOrder');
      expect(productionIn?.refTargetId).toBe(opId);
    } finally {
      await deactivateTrail(api, {
        productionOrderIds: opId ? [opId] : [],
        cuttingOrderId: s.cuttingOrderId,
        motherId: s.mother.id,
        purchaseId: s.purchaseId,
        supplierId: s.supplier.id,
        finish: s.finish,
        productId: s.product.id,
      });
    }
  });

  test('PRODUCTION enlaza a la orden también cuando el ajuste de cierre la referencia directo', async () => {
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
      const theoreticalKg = reported.reports.reduce((acc, r) => acc + Number(r.theoreticalKg), 0);
      // Un `consumedKg` por encima de lo teórico (pero bajo el 10 % de D-057) deja despunte
      // real, y con despunte real `roofingCloseAdjustmentPen` no da cero: es lo que dispara
      // el `ADJUST` que hoy referencia la orden directo, no un reporte.
      const consumedKg = (theoreticalKg * 1.03).toFixed(3);
      await postJson(api, `/api/production/roofing/${op.id}/close`, { consumedKg });

      const productMovements = await movementsOf(api, 'PRODUCT', scenario.product.id);
      const adjust = productMovements.find(
        (m) => m.refType === 'PRODUCTION' && m.type === 'ADJUST',
      );
      expect(adjust, 'el cierre con despunte real tiene que dejar un ADJUST').toBeDefined();
      expect(adjust?.refId).toBe(op.id);
      expect(adjust?.refTargetType).toBe('productionOrder');
      expect(adjust?.refTargetId).toBe(op.id);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('SALE enlaza al pedido; sin mostrador de por medio, la factura queda sin enlazar (deuda documentada en D-205)', async () => {
    const stock = await setupPosStock(api, { qty: '10', listPricePen: '10.0000' });
    const customer = await createCustomer(api);
    const orderIds: string[] = [];
    try {
      const order = await createDirectOrder(api, {
        customerId: customer.id,
        businessLine: stock.product.businessLineCode,
        items: [{ productId: stock.product.id, qty: '3', unitPricePen: '30' }],
      });
      orderIds.push(order.id);
      const dispatch = await dispatchOrder(api, {
        salesOrderId: order.id,
        items: order.items.map((i) => ({
          salesOrderItemId: i.id,
          qty: i.qty,
          weightKg: i.qty,
        })),
      });

      const productMovements = await movementsOf(api, 'PRODUCT', stock.product.id);
      const sale = productMovements.find((m) => m.refType === 'SALE' && m.refId === dispatch.id);
      expect(sale, 'el despacho tiene que dejar una salida SALE').toBeDefined();
      expect(sale?.refTargetType).toBe('salesOrder');
      expect(sale?.refTargetId).toBe(order.id);
      // El flujo estándar factura por `salesOrderId`, sin decir qué despacho cubre: enlazar
      // acá sería inferir, y D-205 lo dejó fuera a propósito.
      expect(sale?.invoiceId).toBeNull();
    } finally {
      await purgeSalesTrail(api, { orderIds });
    }
  });

  test('el mostrador enlaza la factura al despacho en el acto (D-099, único caso sin ambigüedad)', async () => {
    test.skip(!fiscalEmissionAllowed(), FISCAL_EMISSION_REASON);
    const stock = await setupPosStock(api, { qty: '10', listPricePen: '10.0000' });
    let session: CashSessionDto | undefined;
    const orderIds: string[] = [];
    try {
      session = await openCashSession(api, '0.00');
      const sale = await posSell(api, {
        items: [{ productId: stock.product.id, qty: '2.000', unitPricePen: '10.0000' }],
      });
      orderIds.push(sale.salesOrderId);

      const productMovements = await movementsOf(api, 'PRODUCT', stock.product.id);
      const saleMovement = productMovements.find(
        (m) => m.refType === 'SALE' && m.refId === sale.dispatchId,
      );
      expect(saleMovement, 'la venta de mostrador tiene que dejar una salida SALE').toBeDefined();
      expect(saleMovement?.refTargetType).toBe('salesOrder');
      expect(saleMovement?.refTargetId).toBe(sale.salesOrderId);
      expect(saleMovement?.invoiceId).toBe(sale.fiscalDocumentId);
    } finally {
      await closeSessionQuietly(api, session?.id);
      await purgeSalesTrail(api, { orderIds });
    }
  });
});
