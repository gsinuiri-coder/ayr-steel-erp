import { expect, test, type APIRequestContext } from '@playwright/test';
import { canonicalAccessorySku } from '@ayr/shared';
import { adminApi, getJson, postJson } from '../helpers/api';
import { postExpectingError, today } from '../helpers/production';
import {
  mountCoil,
  purgeRoofingTrail,
  reservationsOf,
  roofingOrder,
  setupRoofingScenario,
} from '../helpers/roofing';
import { createCustomer, type QuotationDto } from '../helpers/sales';

/**
 * D-343 — el subtipo ACCESORIO de coberturas, de punta a punta por el API: catálogo con SKU
 * canónico, cotización en metros de bobina sin largos y con piezas informativas, reserva de
 * materia prima, y reporte de producción en metros.
 *
 * La geometría de prueba (acabado de densidad 8.0, 1 000 mm de ancho nominal, 0.50 mm) da 4 kg/m
 * y D-165 los lleva a 4.04 kg/m con el 1 % de merma normal adentro: 25 m son 101.000 kg.
 *
 * Escribe catálogo, cotizaciones, pedidos y producción: nunca contra producción (regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 180_000 });

interface ItemWithHint {
  piecesHint: number | null;
  productRoofingKind: string | null;
  qty: string;
  unit: string;
  reserveQty: string;
  reserveItemType: string;
  description?: string;
  pieces?: unknown[];
  subtotalPen: string;
  totalPen: string;
}

test.describe('D-343 — accesorio', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL);
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  async function createAccessory(s: Awaited<ReturnType<typeof setupRoofingScenario>>) {
    return postJson<{ id: string; sku: string; roofingKind: string; unit: string }>(
      api,
      '/api/catalog',
      {
        businessLineId: s.product.businessLineId,
        sku: canonicalAccessorySku(s.product.thicknessMm ?? '0.50', s.color.code),
        name: 'Accesorio E2E',
        unit: 'MTR',
        source: 'MANUFACTURED',
        listPricePen: '30',
        finishId: s.product.finishId,
        colorId: s.product.colorId,
        thicknessMm: s.product.thicknessMm,
        widthMm: s.product.widthMm,
        roofingKind: 'ACCESORIO',
      },
    );
  }

  async function quote(customerId: string, productId: string, extra: Record<string, unknown>) {
    return postJson<QuotationDto & { items: ItemWithHint[] }>(api, '/api/sales/quotations', {
      customerId,
      issueDate: today(),
      items: [{ productId, qty: '25.000', unitPricePen: '60', ...extra }],
    });
  }

  test('catálogo, cotización con piezas informativas, reserva y reporte en metros', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '1000' });
    const customer = await createCustomer(api);
    const trail = {
      supplierId: s.supplier.id,
      finishId: s.finish.id,
      colorId: s.color.id,
      productIds: [s.product.id],
      coilIds: [s.coil.id],
      purchaseIds: [s.purchaseId],
      orderIds: [] as string[],
      quotationIds: [] as string[],
    };
    try {
      // Catálogo: el SKU se forma con el espesor y el color; otro SKU se rechaza.
      const bad = await postExpectingError(api, '/api/catalog', {
        businessLineId: s.product.businessLineId,
        sku: 'ACCES999MALO',
        name: 'Accesorio con SKU inventado',
        unit: 'MTR',
        source: 'MANUFACTURED',
        finishId: s.product.finishId,
        colorId: s.product.colorId,
        thicknessMm: s.product.thicknessMm,
        widthMm: s.product.widthMm,
        roofingKind: 'ACCESORIO',
      });
      expect(bad.status).toBe(400);
      const accessory = await createAccessory(s);
      trail.productIds.push(accessory.id);
      expect(accessory.roofingKind).toBe('ACCESORIO');
      expect(accessory.unit).toBe('MTR');

      // Cotización: sin largos (los rechaza), con piezas informativas y descripción del usuario.
      const withLengths = await postExpectingError(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [
          {
            productId: accessory.id,
            qty: '25.000',
            unitPricePen: '60',
            pieces: [{ lengthMm: '6250.00', qty: 4 }],
          },
        ],
      });
      expect(withLengths.status).toBe(400);

      const q = await quote(customer.id, accessory.id, {
        piecesHint: 4,
        description: 'Cumbrera 30 cm, 4 piezas de 6.25 m',
      });
      trail.quotationIds.push(q.id);
      const line = q.items[0]!;
      expect(line.piecesHint).toBe(4);
      expect(line.productRoofingKind).toBe('ACCESORIO');
      expect(line.description).toBe('Cumbrera 30 cm, 4 piezas de 6.25 m');
      expect(line.pieces ?? []).toHaveLength(0);
      // Los metros son de bobina y reserva materia prima: 25 m × 4.04 kg/m.
      expect(line.qty).toBe('25.000');
      expect(line.unit).toBe('MTR');
      expect(line.reserveItemType).toBe('RAW_MATERIAL');
      expect(line.reserveQty).toBe('101.000');

      // Las piezas informativas no mueven ningún número.
      const q2 = await quote(customer.id, accessory.id, { piecesHint: 900 });
      trail.quotationIds.push(q2.id);
      expect(q2.items[0]!.reserveQty).toBe(line.reserveQty);
      expect(q2.items[0]!.subtotalPen).toBe(line.subtotalPen);
      expect(q2.items[0]!.totalPen).toBe(line.totalPen);

      // Y solo un accesorio las lleva.
      const notAccessory = await postExpectingError(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [
          {
            productId: s.product.id,
            qty: '25.000',
            unitPricePen: '60',
            piecesHint: 4,
            pieces: [{ lengthMm: '25000.00', qty: 1 }],
          },
        ],
      });
      expect(notAccessory.status).toBe(400);

      // Confirmar: pedido + reserva + OP; el pedido guarda las piezas informativas.
      const order = await postJson<{ id: string; items: ItemWithHint[] }>(
        api,
        `/api/sales/quotations/${q.id}/confirm`,
      );
      trail.orderIds.push(order.id);
      expect(order.items[0]!.piecesHint).toBe(4);
      const [reservation] = await reservationsOf(api, order.id);
      expect(reservation!.qty).toBe('101.000');
      const op = await roofingOrder(api, reservation!.id);

      // Producción: se monta la bobina y se reportan **metros**, no largos.
      await mountCoil(api, op.id, { coilId: s.coil.id });
      const wrongForm = await postExpectingError(api, `/api/production/roofing/${op.id}/report`, {
        pieces: [{ lengthMm: '6250.00', qty: 4 }],
      });
      expect(wrongForm.status).toBe(400);
      await postJson(api, `/api/production/roofing/${op.id}/report`, {
        meters: '25.000',
        piecesCount: 4,
      });
      const detail = await getJson<{
        reports: { status: string; metersM: string | null; pieces: number }[];
      }>(api, `/api/production/${op.id}`);
      const active = detail.reports.filter((r) => r.status === 'ACTIVE');
      expect(active).toHaveLength(1);
      expect(active[0]!.metersM).toBe('25.000');
      expect(active[0]!.pieces).toBe(4);

      // El tablero de planta lo trata como accesorio y muestra los metros del pedido.
      const batch = await getJson<
        { orderId: string; isAccessory: boolean; planMeters: string; reportedMeters: string }[]
      >(api, `/api/production/roofing/batch?salesOrderId=${order.id}`);
      const row = batch.find((b) => b.orderId === op.id);
      expect(row?.isAccessory).toBe(true);
      expect(row?.planMeters).toBe('25.000');
      expect(row?.reportedMeters).toBe('25.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
