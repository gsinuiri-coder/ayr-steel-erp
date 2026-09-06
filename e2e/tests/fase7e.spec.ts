import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson, postJson } from '../helpers/api';
import {
  balanceOf,
  createCuttingSupplier,
  live,
  movementsOf,
  today,
  uniqueDocumentNumber,
  type ProductDto,
  type PurchaseDto,
} from '../helpers/production';
import {
  availabilityOf,
  buyCoilForSale,
  createCustomer,
  createSellableProduct,
  sellableCoils,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';
import {
  createInvoice,
  dispatchOrder,
  purgeInvoicingTrail,
  sendDocument,
  type InvoicingTrail,
} from '../helpers/invoicing';
import {
  UPVC_LINE,
  createColor,
  createRoofingFinish,
  createRoofingProduct,
  purgeRoofingTrail,
} from '../helpers/roofing';

/**
 * Fase 7e — venta de bobina completa, catálogo estructurado y multi-línea (D-116..D-120).
 *
 * En una línea: **una bobina se vende siempre por su saldo vivo completo** (D-116), el
 * catálogo ahora sabe su propia geometría (D-118), un documento puede mezclar líneas de
 * cualquier línea de negocio y se puede duplicar en cualquier estado (D-119), y el corte
 * tercerizado es solo para Drywall (D-120).
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;
const fiscalEmission = process.env.E2E_FISCAL_EMISSION === '1' || !process.env.E2E_BASE_URL;

test.describe.configure({ timeout: 240_000 });

test.describe('Fase 7e — venta de bobina completa, catálogo y multi-línea', () => {
  test.skip(
    !allowWrites,
    'Escrituras contra producción deshabilitadas: exporta E2E_ALLOW_WRITES=1',
  );

  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('vender una bobina con saldo: cotizar, confirmar y despachar deja el kardex en cero al costo real (D-116)', async () => {
    test.skip(!fiscalEmission, 'Emisión fiscal deshabilitada en este entorno (D-072)');

    // Bobina comprada a S/ 5/kg: es el costo real que tiene que salir del kardex, sin
    // relación con el precio negociado de la venta.
    const scenario = await buyCoilForSale(api, {
      lineCode: 'drywall',
      weightKg: '500',
      unitPrice: '5',
      // D-117: sin `coilStatus` nace CERRADA (el default real); D-116 la admite igual
      // para venderla entera.
      coilStatus: 'CLOSED',
    });
    const customer = await createCustomer(api);
    const trail: InvoicingTrail = {
      documentIds: [],
      dispatchIds: [],
      orderIds: [],
      coilIds: [scenario.coil.id],
      purchaseId: scenario.purchaseId,
      supplierId: scenario.supplier.id,
      finish: scenario.finish,
    };

    try {
      // Aparece en el selector con el saldo completo, cerrada, sin costos.
      const offered = (await sellableCoils(api, 'drywall')).find(
        (o) => o.coilId === scenario.coil.id,
      );
      expect(offered).toMatchObject({ status: 'CLOSED', availableQty: '500.000' });

      const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [{ saleCoilId: scenario.coil.id, qty: '1', unitPricePen: '7' }],
      });
      expect(quotation.items).toHaveLength(1);
      // El API resolvió solo el producto y el saldo completo, nunca lo que mandó el input.
      expect(quotation.items[0]).toMatchObject({
        qty: '500.000',
        unit: 'KGM',
        reserveItemType: 'COIL',
        reserveItemId: scenario.coil.id,
        reserveQty: '500.000',
      });
      expect(quotation.items[0]!.description).toContain(scenario.coil.code);

      await postJson(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds!.push(order.id);
      expect(order.status).toBe('CONFIRMED');
      expect(order.reservations[0]).toMatchObject({
        itemType: 'COIL',
        itemId: scenario.coil.id,
        qty: '500.000',
        status: 'ACTIVE',
      });

      // Confirmar puso la bobina en custodia: ya no se ofrece para otra venta.
      expect((await sellableCoils(api, 'drywall')).map((o) => o.coilId)).not.toContain(
        scenario.coil.id,
      );
      expect(await availabilityOf(api, 'COIL', scenario.coil.id)).toMatchObject({
        qty: '500.000',
        reservedQty: '500.000',
        availableQty: '0.000',
      });

      // Despacho total: sale el saldo entero.
      const dispatch = await dispatchOrder(api, {
        salesOrderId: order.id,
        items: [{ salesOrderItemId: order.items[0]!.id, qty: '500' }],
      });
      trail.dispatchIds!.push(dispatch.id);
      expect(dispatch.items[0]).toMatchObject({
        itemType: 'COIL',
        itemId: scenario.coil.id,
        qty: '500.000',
        unit: 'KGM',
      });

      // El kardex queda en cero, y el costo que salió es el real (S/ 5/kg), no el
      // precio negociado (S/ 7/kg) ni ningún otro inventado.
      expect(await balanceOf(api, 'COIL', scenario.coil.id)).toMatchObject({ qty: '0.000' });
      const outMovement = live(await movementsOf(api, 'COIL', scenario.coil.id)).find(
        (m) => m.type === 'OUT',
      );
      expect(outMovement).toMatchObject({ qty: '500.000', refType: 'SALE' });
      expect(outMovement!.totalCost).toBe('2500.0000');

      const fulfilled = await getJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}`);
      expect(fulfilled.status).toBe('FULFILLED');
      expect(fulfilled.reservations[0]).toMatchObject({ status: 'CONSUMED', qty: '0.000' });

      // El comprobante lleva la descripción de la bobina y el mismo peso. No se exige que
      // SUNAT lo acepte (eso depende de si el entorno tiene PSE y un RUC real que probar,
      // D-080): basta con que tome correlativo, que es "emitir" (D-073).
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        salesOrderId: order.id,
        items: [{ salesOrderItemId: order.items[0]!.id, qty: '500' }],
      });
      trail.documentIds!.push(draft.id);
      expect(draft.items[0]).toMatchObject({ qty: '500.000', unit: 'KGM' });
      expect(draft.items[0]!.description).toContain(scenario.coil.code);

      const sent = await sendDocument(api, draft.id);
      expect(sent.number, 'emitir toma correlativo de la serie de factura').not.toBeNull();
      expect(sent.status).not.toBe('DRAFT');
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  test('anular el pedido de una bobina vendida entera libera la custodia y la bobina vuelve al selector (D-116)', async () => {
    const scenario = await buyCoilForSale(api, {
      lineCode: 'metallic-roofing',
      weightKg: '300',
      coilStatus: 'OPEN',
    });
    const customer = await createCustomer(api);
    const trail = {
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      orderIds: [] as string[],
      quotationIds: [] as string[],
    };

    try {
      const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [{ saleCoilId: scenario.coil.id, qty: '1', unitPricePen: '9' }],
      });
      trail.quotationIds.push(quotation.id);
      await postJson(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);

      expect((await sellableCoils(api, 'metallic-roofing')).map((o) => o.coilId)).not.toContain(
        scenario.coil.id,
      );

      await postJson(api, `/api/sales/orders/${order.id}/cancel`, {
        reason: 'Cliente desistió de la compra',
      });

      const cancelled = await getJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}`);
      expect(cancelled.status).toBe('CANCELLED');
      // `SalesOrdersService.cancel` libera la reserva y la deja en cero (D-054), mismo
      // criterio que `reduceReservation`/`releaseRemainingReservation` (hallazgo de esta
      // sesión, corregido: antes dejaba el monto original con status RELEASED).
      expect(cancelled.reservations[0]).toMatchObject({ status: 'RELEASED', qty: '0.000' });

      // Nada movió kardex (D-060): montar/reservar una bobina no toca el saldo.
      expect(await balanceOf(api, 'COIL', scenario.coil.id)).toMatchObject({ qty: '300.000' });

      const offeredAgain = (await sellableCoils(api, 'metallic-roofing')).find(
        (o) => o.coilId === scenario.coil.id,
      );
      expect(offeredAgain).toMatchObject({ status: 'OPEN', availableQty: '300.000' });
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('cotización mixta: producto de stock + bobina completa en el mismo documento, con PDF (D-119)', async () => {
    const cutter = await createCuttingSupplier(api);
    const customer = await createCustomer(api);
    const product = await createSellableProduct(api, {
      lineCode: UPVC_LINE,
      listPricePen: '85',
      unit: 'NIU',
    });
    const finishedPurchase = await postJson<PurchaseDto>(api, '/api/purchases', {
      supplierId: cutter.id,
      businessLine: UPVC_LINE,
      type: 'FINISHED_GOOD',
      docType: 'FACTURA',
      series: 'F001',
      number: uniqueDocumentNumber(),
      issueDate: today(),
      currency: 'PEN',
      igvRate: '18',
      paymentTerms: 'CONTADO',
      items: [
        {
          productId: product.id,
          description: 'Plancha UPVC E2E cotización mixta',
          qty: '10',
          unit: 'NIU',
          unitPrice: '50',
        },
      ],
    });
    await postJson(api, `/api/purchases/${finishedPurchase.id}/receive`);

    const coilScenario = await buyCoilForSale(api, {
      lineCode: 'drywall',
      weightKg: '200',
      coilStatus: 'CLOSED',
    });

    try {
      const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [
          { productId: product.id, qty: '3', unitPricePen: '85' },
          { saleCoilId: coilScenario.coil.id, qty: '1', unitPricePen: '6' },
        ],
      });
      expect(quotation.items).toHaveLength(2);

      const detail = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
      // La bobina completa vende el SKU `trading` (D-037): las dos líneas de negocio son
      // distintas entre sí (`roofing` del UPVC y `trading` de la venta directa de bobina).
      expect(detail.businessLines.length).toBeGreaterThan(1);
      expect(detail.businessLines).toEqual(expect.arrayContaining(['roofing', 'trading']));

      await postJson(api, `/api/sales/quotations/${quotation.id}/emit`);
      const pdfRes = await api.get(`/api/sales/quotations/${quotation.id}/pdf`);
      expect(pdfRes.ok()).toBe(true);
      expect(pdfRes.headers()['content-type']).toContain('application/pdf');

      await api
        .post(`/api/sales/quotations/${quotation.id}/cancel`, {
          data: { reason: 'Limpieza de prueba E2E' },
        })
        .catch(() => undefined);
    } finally {
      await api
        .post(`/api/coils/${coilScenario.coil.id}/cancel`, {
          data: { reason: 'Limpieza de prueba E2E' },
        })
        .catch(() => undefined);
      await api
        .post(`/api/purchases/${coilScenario.purchaseId}/cancel`, {
          data: { reason: 'Limpieza de prueba E2E' },
        })
        .catch(() => undefined);
      await api
        .post(`/api/purchases/${finishedPurchase.id}/cancel`, {
          data: { reason: 'Limpieza de prueba E2E' },
        })
        .catch(() => undefined);
      await api
        .patch(`/api/catalog/${product.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .patch(`/api/finishes/${coilScenario.finish.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .patch(`/api/suppliers/${cutter.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .patch(`/api/suppliers/${coilScenario.supplier.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
  });

  test('duplicar una cotización confirmada crea un borrador nuevo con las mismas líneas, sin tocar la original (D-119)', async () => {
    const supplier = await createCuttingSupplier(api);
    const customer = await createCustomer(api);
    const product = await createSellableProduct(api, {
      lineCode: 'drywall',
      listPricePen: '20',
      unit: 'NIU',
    });
    const purchase = await postJson<PurchaseDto>(api, '/api/purchases', {
      supplierId: supplier.id,
      businessLine: 'drywall',
      type: 'FINISHED_GOOD',
      docType: 'FACTURA',
      series: 'F001',
      number: uniqueDocumentNumber(),
      issueDate: today(),
      currency: 'PEN',
      igvRate: '18',
      paymentTerms: 'CONTADO',
      items: [
        {
          productId: product.id,
          description: 'Perfil E2E de stock para duplicar',
          qty: '20',
          unit: 'NIU',
          unitPrice: '10',
        },
      ],
    });
    await postJson(api, `/api/purchases/${purchase.id}/receive`);

    let orderId: string | null = null;
    let duplicatedId: string | null = null;
    const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
      customerId: customer.id,
      issueDate: today(),
      items: [{ productId: product.id, qty: '5', unitPricePen: '20' }],
    });

    try {
      await postJson(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      orderId = order.id;

      const duplicated = await postJson<QuotationDto>(
        api,
        `/api/sales/quotations/${quotation.id}/duplicate`,
      );
      duplicatedId = duplicated.id;
      expect(duplicated.status).toBe('DRAFT');
      expect(duplicated.code).not.toBe(quotation.code);
      expect(duplicated.customerId).toBe(customer.id);
      expect(duplicated.items).toHaveLength(1);
      expect(duplicated.items[0]).toMatchObject({ productId: product.id, qty: '5.000' });

      // La original sigue exactamente como estaba: confirmada, con su propia línea intacta.
      const original = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
      expect(original.status).toBe('CONFIRMED');
      expect(original.code).toBe(quotation.code);
      expect(original.items[0]).toMatchObject({ productId: product.id, qty: '5.000' });
    } finally {
      if (duplicatedId) {
        await api
          .post(`/api/sales/quotations/${duplicatedId}/cancel`, {
            data: { reason: 'Limpieza de prueba E2E' },
          })
          .catch(() => undefined);
      }
      if (orderId) {
        await api
          .post(`/api/sales/orders/${orderId}/cancel`, {
            data: { reason: 'Limpieza de prueba E2E' },
          })
          .catch(() => undefined);
      }
      await api
        .post(`/api/sales/quotations/${quotation.id}/cancel`, {
          data: { reason: 'Limpieza de prueba E2E' },
        })
        .catch(() => undefined);
      await api
        .post(`/api/purchases/${purchase.id}/cancel`, {
          data: { reason: 'Limpieza de prueba E2E' },
        })
        .catch(() => undefined);
      await api
        .patch(`/api/catalog/${product.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .patch(`/api/suppliers/${supplier.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
  });

  test('duplicar una cotización cuya bobina ya se vendió deja un error claro por esa línea, no un 500 (D-119)', async () => {
    const customer = await createCustomer(api);
    const scenario = await buyCoilForSale(api, {
      lineCode: 'drywall',
      weightKg: '150',
      coilStatus: 'CLOSED',
    });
    const trail = {
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      orderIds: [] as string[],
      quotationIds: [] as string[],
    };

    try {
      const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [{ saleCoilId: scenario.coil.id, qty: '1', unitPricePen: '6' }],
      });
      trail.quotationIds.push(quotation.id);
      await postJson(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);

      // El pedido se despacha entero: el saldo de la bobina queda en cero, sin nada que
      // una segunda venta pueda volver a prometer.
      const dispatch = await dispatchOrder(api, {
        salesOrderId: order.id,
        items: [{ salesOrderItemId: order.items[0]!.id, qty: '150' }],
      });

      const res = await api.post(`/api/sales/quotations/${quotation.id}/duplicate`);
      expect(res.status()).toBe(400);
      const body = (await res.json()) as { message?: string | string[] };
      const message = Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? '');
      expect(message).toContain(scenario.coil.code);

      await api
        .post(`/api/dispatches/${dispatch.id}/reverse`, {
          data: { reason: 'Limpieza de prueba E2E' },
        })
        .catch(() => undefined);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('plancha de catálogo con receta: cotizar solo con cantidad expone el kg teórico coherente con espesor × ancho × densidad (D-118)', async () => {
    const finish = await createRoofingFinish(api);
    const color = await createColor(api);
    const { product } = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: color.id,
      pieceLengthMm: '3000',
    });
    const customer = await createCustomer(api);
    const trail = {
      finishId: finish.id,
      colorId: color.id,
      productIds: [product.id],
      quotationIds: [] as string[],
    };

    try {
      const catalog = await getJson<ProductDto & { theoreticalKgPerUnit: string | null }>(
        api,
        `/api/catalog/${product.id}`,
      );
      expect(catalog.unit).toBe('NIU');
      expect(catalog.thicknessMm).toBe('0.50');
      expect(catalog.widthMm).toBe('1000.00');
      // 1000 mm de ancho × 0.50 mm de espesor × 3000 mm de largo × 8.0 de densidad / 1e6
      // = 12 kg por plancha.
      expect(catalog.theoreticalKgPerUnit).toBe('12.000');

      const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [{ productId: product.id, qty: '4', unitPricePen: '90' }],
      });
      trail.quotationIds.push(quotation.id);
      expect(quotation.items[0]).toMatchObject({
        productId: product.id,
        qty: '4.000',
        unit: 'NIU',
      });
      expect(quotation.items[0]!.pieces).toHaveLength(0);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('el corte tercerizado acepta una bobina de Drywall y rechaza una de Metallic Roofing (D-120)', async () => {
    const cutter = await createCuttingSupplier(api);
    const roofing = await buyCoilForSale(api, {
      lineCode: 'metallic-roofing',
      weightKg: '400',
      coilStatus: 'OPEN',
    });
    const drywall = await buyCoilForSale(api, {
      lineCode: 'drywall',
      weightKg: '400',
      coilStatus: 'OPEN',
    });
    let cuttingOrderId: string | null = null;

    try {
      const rejectedRes = await api.post('/api/cutting', {
        data: {
          supplierId: cutter.id,
          notes: 'Intento de corte sobre bobina de Metallic Roofing',
          coils: [
            {
              coilId: roofing.coil.id,
              widthPlanMm: [{ widthMm: '500', stripsCount: 1 }],
              expectedKerfLossMm: '0',
            },
          ],
        },
      });
      expect(rejectedRes.status()).toBe(400);
      const rejectedBody = (await rejectedRes.json()) as { message?: string };
      expect(rejectedBody.message ?? '').toMatch(/Drywall/);

      const accepted = await postJson<{ id: string; status: string }>(api, '/api/cutting', {
        supplierId: cutter.id,
        notes: 'Corte E2E Drywall aceptado (D-120)',
        coils: [
          {
            coilId: drywall.coil.id,
            widthPlanMm: [{ widthMm: '600', stripsCount: 1 }],
            expectedKerfLossMm: '0',
          },
        ],
      });
      cuttingOrderId = accepted.id;
      expect(accepted.status).toBe('SENT');
    } finally {
      if (cuttingOrderId) {
        await api
          .post(`/api/cutting/${cuttingOrderId}/cancel`, {
            data: { reason: 'Limpieza de prueba E2E' },
          })
          .catch(() => undefined);
      }
      await purgeRoofingTrail(api, {
        coilIds: [roofing.coil.id, drywall.coil.id],
        purchaseIds: [roofing.purchaseId, drywall.purchaseId],
      });
      await api
        .patch(`/api/suppliers/${cutter.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .patch(`/api/suppliers/${roofing.supplier.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .patch(`/api/suppliers/${drywall.supplier.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .patch(`/api/finishes/${roofing.finish.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .patch(`/api/finishes/${drywall.finish.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
  });
});
