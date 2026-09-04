import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, postJson } from '../helpers/api';
import {
  balanceOf,
  createCuttingSupplier,
  live,
  movementsOf,
  postExpectingError,
  putExpectingError,
  today,
  type CoilDto,
  type CuttingOrderDto,
  type ProductionOrderDto,
} from '../helpers/production';
import { availabilityOf, createCustomer } from '../helpers/sales';
import { createInvoice, dispatchOrder } from '../helpers/invoicing';
import {
  buyRoofingCoil,
  coilOptions,
  createColor,
  createRoofingProduct,
  metersOf,
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  reservationsOf,
  roofingOrder,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * Fase 6 — bordes, guardrails y reversas de la producción de coberturas.
 *
 * `fase6.spec.ts` prueba que el camino feliz cuadra; este prueba que **no hay atajos**: el
 * filtro de bobina no ofrece lo que no sirve, la bobina montada no se la puede llevar nadie,
 * y cada reversa deja el sistema exactamente como estaba —o falla entera.
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;

test.describe.configure({ timeout: 240_000 });

test.describe('Fase 6 — bordes y reversas de coberturas', () => {
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

  test('el filtro de bobina descarta espesor fuera de tolerancia, color distinto y rollo en corte (D-086)', async () => {
    const supplier = await createCuttingSupplier(api);
    const cutter = await createCuttingSupplier(api);
    const scenario = await setupRoofingScenario(api, { weightKg: '800' });
    const otroColor = await createColor(api, '#0033a0');
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
    };
    const extras: { coilIds: string[]; purchaseIds: string[] } = { coilIds: [], purchaseIds: [] };

    try {
      // Dentro de tolerancia: 0.52 contra 0.50 nominal son 0.02 exactos ⇒ **sí** aparece.
      const enTolerancia = await buyRoofingCoil(api, {
        supplierId: supplier.id,
        finishId: scenario.finish.id,
        colorId: scenario.color.id,
        thicknessMm: '0.52',
        weightKg: '600',
      });
      // Fuera de tolerancia por una centésima ⇒ **no** aparece.
      const fuera = await buyRoofingCoil(api, {
        supplierId: supplier.id,
        finishId: scenario.finish.id,
        colorId: scenario.color.id,
        thicknessMm: '0.53',
        weightKg: '600',
      });
      // Espesor correcto pero otro color ⇒ **no** aparece.
      const otroColorCoil = await buyRoofingCoil(api, {
        supplierId: supplier.id,
        finishId: scenario.finish.id,
        colorId: otroColor.id,
        weightKg: '600',
      });
      // Espesor y color correctos, pero sin color declarado ⇒ **no** aparece: la igualdad
      // es estricta, `null` incluido, y ahí está la mitad del valor de la regla.
      const sinColor = await buyRoofingCoil(api, {
        supplierId: supplier.id,
        finishId: scenario.finish.id,
        weightKg: '600',
      });
      extras.coilIds = [
        enTolerancia.coil.id,
        fuera.coil.id,
        otroColorCoil.coil.id,
        sinColor.coil.id,
      ];
      extras.purchaseIds = [
        enTolerancia.purchaseId,
        fuera.purchaseId,
        otroColorCoil.purchaseId,
        sinColor.purchaseId,
      ];

      const offered = (await coilOptions(api, scenario.product.id)).map((o) => o.coilId);
      expect(offered).toContain(scenario.coil.id);
      expect(offered).toContain(enTolerancia.coil.id);
      expect(offered).not.toContain(fuera.coil.id);
      expect(offered).not.toContain(otroColorCoil.coil.id);
      expect(offered).not.toContain(sinColor.coil.id);

      // Una bobina en corte tercerizado tampoco aparece: sigue siendo nuestra (D-050) pero
      // no está en la planta.
      await postJson<CuttingOrderDto>(api, '/api/cutting', {
        supplierId: cutter.id,
        notes: 'Corte E2E Fase 6 para sacar la bobina del filtro',
        coils: [
          {
            coilId: enTolerancia.coil.id,
            widthPlanMm: [{ widthMm: '500', stripsCount: 1 }],
            expectedKerfLossMm: '0',
          },
        ],
      });
      const afterSend = (await coilOptions(api, scenario.product.id)).map((o) => o.coilId);
      expect(afterSend).not.toContain(enTolerancia.coil.id);
    } finally {
      await purgeRoofingTrail(api, { ...trail, coilIds: [...(trail.coilIds ?? [])] });
      await purgeRoofingTrail(api, {
        coilIds: extras.coilIds,
        purchaseIds: extras.purchaseIds,
        supplierId: supplier.id,
      });
      await api
        .patch(`/api/suppliers/${cutter.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .patch(`/api/colors/${otroColor.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
  });

  test('la bobina montada queda en custodia: no se merma, ni se cierra, ni se manda a corte (D-060)', async () => {
    const cutter = await createCuttingSupplier(api);
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
    const extras: { coilIds: string[]; purchaseIds: string[] } = { coilIds: [], purchaseIds: [] };

    try {
      const rows = pieces([4, 3]);
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '60',
        rows,
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const reservation = (await reservationsOf(api, order.id))[0]!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: scenario.coil.id,
      });

      // Montar saltándose el filtro se rechaza con el motivo real, no con un genérico.
      const fuera = await buyRoofingCoil(api, {
        supplierId: scenario.supplier.id,
        finishId: scenario.finish.id,
        colorId: scenario.color.id,
        thicknessMm: '0.53',
        weightKg: '300',
      });
      extras.coilIds.push(fuera.coil.id);
      extras.purchaseIds.push(fuera.purchaseId);
      const porEspesor = await postExpectingError(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: fuera.coil.id,
      });
      expect(porEspesor.message).toContain('espesor');

      const sinColor = await buyRoofingCoil(api, {
        supplierId: scenario.supplier.id,
        finishId: scenario.finish.id,
        weightKg: '300',
      });
      extras.coilIds.push(sinColor.coil.id);
      extras.purchaseIds.push(sinColor.purchaseId);
      const porColor = await postExpectingError(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: sinColor.coil.id,
      });
      expect(porColor.message).toContain('color');

      const merma = await postExpectingError(api, `/api/coils/${scenario.coil.id}/scrap`, {
        qtyKg: '10',
        reason: 'Intento de merma sobre bobina montada',
      });
      expect(merma.status).toBe(400);
      expect(merma.message).toMatch(/orden de producción/i);

      const cierre = await postExpectingError(api, `/api/coils/${scenario.coil.id}/status`, {
        status: 'CLOSED',
        reason: 'Intento de cierre sobre bobina montada',
      });
      expect(cierre.status).toBe(400);

      const anular = await postExpectingError(api, `/api/coils/${scenario.coil.id}/cancel`, {
        reason: 'Intento de anulación sobre bobina montada',
      });
      expect(anular.status).toBe(400);

      const corte = await postExpectingError(api, '/api/cutting', {
        supplierId: cutter.id,
        notes: 'Intento de corte con la bobina montada',
        coils: [
          {
            coilId: scenario.coil.id,
            widthPlanMm: [{ widthMm: '500', stripsCount: 1 }],
            expectedKerfLossMm: '0',
          },
        ],
      });
      expect(corte.status).toBe(400);

      // Y el ancho, que cambiaría el kilo por metro a mitad de corrida (D-047).
      const ancho = await api.patch(`/api/coils/${scenario.coil.id}`, {
        data: { widthMm: '900' },
      });
      expect(ancho.status()).toBe(400);
    } finally {
      await purgeRoofingTrail(api, trail);
      await purgeRoofingTrail(api, { coilIds: extras.coilIds, purchaseIds: extras.purchaseIds });
      await api
        .patch(`/api/suppliers/${cutter.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
  });

  test('revertir el reporte devuelve los kilos a la bobina y la promesa con ellos (D-088)', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '1000' });
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
      const rows = pieces([4, 3]); // 12 m ⇒ 48 kg
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '60',
        rows,
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const reservation = (await reservationsOf(api, order.id))[0]!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: scenario.coil.id,
      });
      const reported = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/report`,
        { pieces: rows },
      );
      const report = reported.reports.find((r) => r.status === 'ACTIVE')!;
      expect(report.theoreticalKg).toBe('48.000');
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('952.000');

      const reverted = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/reports/${report.id}/reverse`,
        { reason: 'Los largos salieron mal medidos' },
      );
      expect(reverted.status).toBe('IN_PROGRESS');
      expect(reverted.piecesReported).toBe(0);
      expect(reverted.reports.find((r) => r.id === report.id)?.status).toBe('REVERTED');

      // El saldo de la bobina vuelve exacto, y el producto queda en cero.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1000.000');
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('0.000');

      // Y la promesa vuelve a la bobina: la reserva sobre el producto se libera y la de
      // materia prima recupera los kilos. Sin esto, el material volvería al almacén sin
      // nada que lo proteja mientras el pedido lo sigue prometiendo.
      const after = await reservationsOf(api, order.id);
      const onCoil = after.find((r) => r.itemType === 'COIL')!;
      const onProduct = after.find((r) => r.itemType === 'PRODUCT');
      expect(onCoil).toMatchObject({ qty: '60.000', status: 'ACTIVE' });
      expect(onProduct?.status).toBe('RELEASED');
      expect((await availabilityOf(api, 'COIL', scenario.coil.id)).reservedQty).toBe('60.000');

      // El kardex quedó con los pares movimiento + reversa que se anulan entre sí.
      expect(live(await movementsOf(api, 'PRODUCT', scenario.product.id))).toHaveLength(0);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('la reversa se bloquea si las planchas ya salieron en un despacho (RF-36)', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '1000' });
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
    let dispatchId: string | null = null;

    try {
      const rows = pieces([4, 2]); // 8 m ⇒ 32 kg
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '40',
        rows,
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const reservation = (await reservationsOf(api, order.id))[0]!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: scenario.coil.id,
      });
      const reported = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/report`,
        { pieces: rows },
      );
      const report = reported.reports.find((r) => r.status === 'ACTIVE')!;
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/close`, {});

      // **La prueba del hueco de D-088**: el despacho tiene que sacar los METROS del
      // producto, no volver a sacar los kilos de la bobina.
      const coilBefore = await balanceOf(api, 'COIL', scenario.coil.id);
      const dispatch = await dispatchOrder(api, {
        salesOrderId: order.id,
        items: [{ salesOrderItemId: order.items[0]!.id, qty: metersOf(rows), weightKg: '32' }],
      });
      dispatchId = dispatch.id;

      const coilAfter = await balanceOf(api, 'COIL', scenario.coil.id);
      expect(coilAfter.qty).toBe(coilBefore.qty);
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('0.000');
      expect(dispatch.items[0]).toMatchObject({ itemType: 'PRODUCT', itemId: scenario.product.id });

      // Con el material ya en la calle, reabrir y revertir el reporte falla completa.
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/reopen`, {
        reason: 'Intento de corrección con el material ya despachado',
      }).catch(() => undefined);
      const blocked = await postExpectingError(
        api,
        `/api/production/roofing/${op.id}/reports/${report.id}/reverse`,
        { reason: 'Intento de reversa con planchas despachadas' },
      );
      expect(blocked.status).toBe(400);
      expect(blocked.message).toMatch(/movieron|movimientos/i);

      // Y el comprobante lleva los largos en la descripción de la línea.
      const invoice = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        salesOrderId: order.id,
        items: [{ salesOrderItemId: order.items[0]!.id, qty: metersOf(rows) }],
      });
      expect(invoice.items[0]?.description).toContain('4.00 m');
      expect(invoice.items[0]?.unit).toBe('MTR');
      await api
        .post(`/api/invoicing/documents/${invoice.id}/discard`, {
          data: { reason: 'Limpieza de prueba E2E' },
        })
        .catch(() => undefined);
    } finally {
      if (dispatchId) {
        await api
          .post(`/api/dispatches/${dispatchId}/reverse`, {
            data: { reason: 'Limpieza de prueba E2E' },
          })
          .catch(() => undefined);
      }
      await purgeRoofingTrail(api, trail);
    }
  });

  test('despachar una cobertura antes de producirla se rechaza: nunca sale la bobina (D-088)', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '600' });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      orderIds: [],
      quotationIds: [],
    };

    try {
      const rows = pieces([4, 2]);
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '40',
        rows,
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];

      // El pedido promete kilos de la bobina, pero lo que se vende son planchas. Sin
      // producción no hay nada que despachar: caer a las coordenadas congeladas habría
      // sacado 40 kg de bobina por una venta de 8 m de cobertura, y el reporte de la OP los
      // habría vuelto a sacar después. Es el hueco que D-088 vino a cerrar.
      const antes = await balanceOf(api, 'COIL', scenario.coil.id);
      const rechazado = await postExpectingError(api, '/api/dispatches', {
        salesOrderId: order.id,
        dispatchDate: today(),
        originAddress: 'Almacén E2E',
        destinationAddress: 'Obra E2E',
        originUbigeo: '150101',
        destinationUbigeo: '150101',
        transferMode: 'PRIVATE',
        totalWeightKg: '32.000',
        vehiclePlate: 'AAA111',
        driverGivenNames: 'Juan',
        driverFamilyNames: 'Pérez',
        driverDocType: 'DNI',
        driverDocNumber: '12345678',
        driverLicense: 'Q12345678',
        items: [{ salesOrderItemId: order.items[0]!.id, qty: metersOf(rows), weightKg: '32' }],
      });
      expect(rechazado.status).toBe(400);
      expect(rechazado.message).toMatch(/produce/i);

      // Y el saldo de la bobina quedó intacto: el rechazo es antes de tocar el kardex.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe(antes.qty);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('anular la OP libera la bobina y devuelve la promesa al pedido (RF-33)', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '700' });
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
      const rows = pieces([3, 2]);
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '30',
        rows,
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const reservation = (await reservationsOf(api, order.id))[0]!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: scenario.coil.id,
      });

      const cancelled = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${op.id}/cancel`,
        { reason: 'El cliente cambió la medida' },
      );
      expect(cancelled.status).toBe('CANCELLED');
      // Montar no movió kardex, así que anular no tiene nada que revertir: el saldo intacto.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('700.000');
      // La bobina vuelve a estar libre para el filtro.
      expect(
        (await coilOptions(api, scenario.product.id, reservation.id)).map((o) => o.coilId),
      ).toContain(scenario.coil.id);
      // Y la reserva del pedido sigue viva, protegiéndola.
      expect((await reservationsOf(api, order.id))[0]).toMatchObject({
        itemType: 'COIL',
        status: 'ACTIVE',
        qty: '30.000',
      });
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('sin pedido no hay producción de coberturas, y la receta no se puede llenar de más (RF-31, D-087)', async () => {
    const supplier = await createCuttingSupplier(api);
    const color = await createColor(api);
    const scenario = await setupRoofingScenario(api, { weightKg: '400' });
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
    };
    const extraProductIds: string[] = [];

    try {
      // RF-31: la ruta de drywall rechaza un producto de coberturas.
      const porRuta = await postExpectingError(api, '/api/production', {
        productId: scenario.product.id,
      });
      expect(porRuta.status).toBe(400);
      expect(porRuta.message).toMatch(/coberturas/i);

      // Y `POST /production/roofing` sin reserva ni siquiera pasa el schema.
      const sinReserva = await postExpectingError(api, '/api/production/roofing', {});
      expect(sinReserva.status).toBe(400);

      // D-087: una receta de cobertura no fija el ancho ni el kilo — la geometría la trae
      // el rollo que se monte. Mandarlos significa creer lo contrario, y se rechaza.
      const conAncho = await api.put(`/api/production/boms/${scenario.product.id}`, {
        data: {
          kind: 'ROOFING',
          finishId: scenario.finish.id,
          inputThicknessMm: '0.50',
          inputWidthMm: '1000',
        },
      });
      expect(conAncho.status()).toBe(400);
      // El detalle por campo va en `errors`, no en `message`: es Zod quien corta.
      const detail = (await conAncho.json()) as { errors?: Record<string, string[]> };
      expect(JSON.stringify(detail.errors ?? {})).toMatch(/ancho/i);

      // D-083: la unidad del producto separa los dos tipos. Una receta **sin** largo es una
      // cobertura a medida y exige `MTR`; pedirla sobre un producto en piezas se rechaza,
      // porque en un saldo de piezas dos planchas de largo distinto valdrían lo mismo.
      const enPiezas = await createRoofingProduct(api, {
        finishId: scenario.finish.id,
        colorId: color.id,
        pieceLengthMm: '3000',
      });
      extraProductIds.push(enPiezas.product.id);
      const unidadMal = await putExpectingError(
        api,
        `/api/production/boms/${enPiezas.product.id}`,
        { kind: 'ROOFING', finishId: scenario.finish.id, inputThicknessMm: '0.50' },
      );
      expect(unidadMal.status).toBe(400);
      expect(unidadMal.message).toMatch(/metros lineales/i);
    } finally {
      await purgeRoofingTrail(api, {
        ...trail,
        productIds: [...(trail.productIds ?? []), ...extraProductIds],
      });
      await purgeRoofingTrail(api, { supplierId: supplier.id, colorId: color.id });
    }
  });
});
