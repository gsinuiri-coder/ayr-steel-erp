import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson } from '../helpers/api';
import { createCustomer } from '../helpers/sales';
import {
  buyRoofingCoil,
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  reservationsOf,
  roofingOrder,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * **D-172/D-173 (T4/T6) por API**: qué OP —y qué pedido detrás de ella— montaron una bobina
 * (`GET /coils/:id/consumptions`), y los dos PDF nuevos (`GET /coils/:id/pdf`,
 * `GET /coils/report-pdf`).
 *
 * Lo que estos casos fijan, en una línea: la punta opuesta del enlace bidireccional
 * bobina↔producción existe de verdad —una bobina sin montar trae `[]` y no un error, una
 * bobina montada trae el código de la OP y, si detrás hay un pedido, también el suyo— y los
 * dos PDF son descargas reales, no una ruta que responde 200 con el cuerpo vacío.
 *
 * Escribe kardex indirectamente (monta una bobina en una OP): contra producción solo con
 * `E2E_ALLOW_WRITES=1` (D-024, regla dura 9), igual que el resto de Fase 6.
 */
const isProduction = !!process.env.E2E_BASE_URL;
const skipWrites = isProduction && process.env.E2E_ALLOW_WRITES !== '1';

test.describe.configure({ timeout: 180_000 });

test.describe('D-172/D-173 — consumos de una bobina y sus PDF', () => {
  test.skip(
    skipWrites,
    'Monta una bobina en una OP: contra producción solo con E2E_ALLOW_WRITES=1',
  );

  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('una bobina sin montar trae [], y una bobina montada en una OP trae la orden y el pedido detrás', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '500' });
    const { coil: unmountedCoil, purchaseId: unmountedPurchaseId } = await buyRoofingCoil(api, {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      weightKg: '300',
    });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id, unmountedCoil.id],
      purchaseIds: [scenario.purchaseId, unmountedPurchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      // Una bobina que nadie montó todavía: la lista está vacía, no es un error.
      const emptyConsumptions = await getJson<unknown[]>(
        api,
        `/api/coils/${unmountedCoil.id}/consumptions`,
      );
      expect(emptyConsumptions).toEqual([]);

      const rows = pieces([4, 2]);
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows,
        unitPricePen: '30',
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];

      const reservations = await reservationsOf(api, order.id);
      const created = await roofingOrder(api, reservations[0]!.id);
      trail.productionOrderIds = [created.id];

      const mounted = await mountCoil(api, created.id, { coilId: scenario.coil.id });
      expect(mounted.status).toBe('IN_PROGRESS');

      const consumptions = await getJson<
        {
          productionOrderId: string;
          productionOrderCode: string;
          productionOrderKind: string;
          productionOrderStatus: string;
          productSku: string;
          assignedKg: string;
          consumedKg: string;
          salesOrderId: string | null;
          salesOrderCode: string | null;
          customerName: string | null;
        }[]
      >(api, `/api/coils/${scenario.coil.id}/consumptions`);
      expect(consumptions).toHaveLength(1);
      expect(consumptions[0]).toMatchObject({
        productionOrderId: created.id,
        productionOrderCode: created.code,
        productionOrderKind: 'ROOFING',
        productionOrderStatus: 'IN_PROGRESS',
        productSku: scenario.product.sku,
        // Montar es custodia (D-060): todavía no se consumió nada del kardex.
        assignedKg: '500.000',
        consumedKg: '0.000',
        salesOrderId: order.id,
        salesOrderCode: order.code,
        customerName: customer.name,
      });

      // Y la bobina que nunca se montó sigue en [], aunque ya exista una OP en curso.
      expect(await getJson<unknown[]>(api, `/api/coils/${unmountedCoil.id}/consumptions`)).toEqual(
        [],
      );
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('el PDF de una bobina se descarga con su contenido', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '400' });
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
    };

    try {
      const res = await api.get(`/api/coils/${scenario.coil.id}/pdf`);
      expect(res.ok(), 'El PDF de la bobina debía descargarse').toBe(true);
      expect(res.headers()['content-type']).toContain('application/pdf');
      expect(res.headers()['content-disposition']).toContain('attachment');
      const body = await res.body();
      expect(body.length).toBeGreaterThan(0);
      // `%PDF` es la firma del formato: sin esto, un cuerpo vacío pasaría el chequeo.
      expect(body.subarray(0, 4).toString()).toBe('%PDF');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('el PDF del listado filtrado se descarga con al menos un filtro', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '400' });
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
    };

    try {
      const res = await api.get(
        `/api/coils/report-pdf?businessLine=metallic-roofing&supplierId=${scenario.supplier.id}`,
      );
      expect(res.ok(), 'El PDF del listado debía descargarse').toBe(true);
      expect(res.headers()['content-type']).toContain('application/pdf');
      const body = await res.body();
      expect(body.length).toBeGreaterThan(0);
      expect(body.subarray(0, 4).toString()).toBe('%PDF');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
