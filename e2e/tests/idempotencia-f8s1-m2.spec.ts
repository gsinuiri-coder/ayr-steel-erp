import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { adminApi, createSupplier, getJson, postJson } from '../helpers/api';
import {
  balanceOf,
  setupScenario,
  today,
  uniqueDocumentNumber,
  type ProductionOrderDto,
} from '../helpers/production';
import { createCustomer, createDirectOrder, createSellableProduct } from '../helpers/sales';
import { dispatchOrder, type FiscalDocumentDto } from '../helpers/invoicing';

/**
 * F8-S1/M2 — verificación obligatoria: la misma mutación crítica, disparada dos veces en
 * paralelo, produce UN solo efecto.
 *
 * La auditoría de la sesión encontró que casi todo el API ya seguía el patrón correcto
 * (`SELECT ... FOR UPDATE` o `updateMany` condicionado al estado esperado, dentro de la
 * transacción) desde arreglos de Fase 2a. Un hallazgo real: `issueDispatchNote` («Emitir
 * guía») leía `dispatch.documents` sin bloquear la fila del despacho, así que dos clicks
 * simultáneos podían crear dos guías electrónicas vigentes para el mismo traslado físico.
 * Corregido con el mismo lock que ya usa `DispatchesService.reverse`.
 *
 * Las dos creaciones repetibles de la lista (reportar producción, registrar pago) no
 * tenían corrupción de datos —ya estaban bajo `lockOrder`/`FOR UPDATE`— pero tampoco
 * tenían cómo distinguir "dos hechos iguales" de "el mismo intento contado dos veces".
 * D-182 agrega una clave de idempotencia opcional, generada por el cliente por intento.
 */

const isProduction = !!process.env.E2E_BASE_URL;

test.describe('F8-S1/M2 — idempotencia server-side', () => {
  test.skip(
    isProduction,
    'Crea pedidos, órdenes de producción y pagos: nunca contra producción (D-126, regla dura 9).',
  );

  test('emitir guía dos veces en paralelo sobre el mismo despacho crea UNA sola guía', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);

    const supplier = await createSupplier(api, { name: 'E2E Proveedor guía concurrente' });
    const product = await createSellableProduct(api, {
      lineCode: 'drywall',
      listPricePen: '50.0000',
    });
    const purchase = await postJson<{ id: string }>(api, '/api/purchases', {
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
          description: 'Producto E2E con stock propio',
          qty: '10',
          unit: 'NIU',
          unitPrice: '30',
        },
      ],
    });
    await postJson(api, `/api/purchases/${purchase.id}/receive`);

    const customer = await createCustomer(api);
    const order = await createDirectOrder(api, {
      customerId: customer.id,
      businessLine: 'drywall',
      items: [{ productId: product.id, qty: '5', unitPricePen: '50.0000' }],
    });

    const dispatch = await dispatchOrder(api, {
      salesOrderId: order.id,
      items: [{ salesOrderItemId: order.items[0]!.id, qty: '5', weightKg: '30' }],
    });

    // Dos "Emitir guía" a la vez sobre el MISMO despacho: sin el lock de D-182/M2, los dos
    // pasaban el chequeo de "sin guía vigente" y cada uno creaba su propio borrador y su
    // propio correlativo.
    const [r1, r2] = await Promise.all([
      api.post(`/api/dispatches/${dispatch.id}/dispatch-note`),
      api.post(`/api/dispatches/${dispatch.id}/dispatch-note`),
    ]);
    const results = [r1, r2];
    const winners = results.filter((r) => r.ok());
    const losers = results.filter((r) => !r.ok());
    expect(winners, 'solo una emisión puede ganar la carrera por el mismo despacho').toHaveLength(
      1,
    );
    expect(losers).toHaveLength(1);
    expect(
      losers[0]!.status(),
      'la perdedora debe ver el 409 de dominio, no un error de base',
    ).toBe(409);
    const loserBody = (await losers[0]!.json()) as { message?: string };
    expect(loserBody.message).toContain('ya tiene la guía');

    // La guía que ganó existe de verdad y es del despacho correcto — el entorno local no
    // tiene credenciales reales del PSE, así que el estado final típico es `REJECTED` (no
    // hay Nubefact real que la acepte); eso es aparte de lo que este test verifica, que es
    // que nunca se creó una segunda.
    const winnerNote = (await winners[0]!.json()) as FiscalDocumentDto;
    const reloadedNote = await getJson<FiscalDocumentDto>(
      api,
      `/api/invoicing/documents/${winnerNote.id}`,
    );
    expect(reloadedNote.dispatchId).toBe(dispatch.id);
  });

  test('reportar producción dos veces con la misma clave de intento no duplica el kardex', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupScenario(api);
    const strip = s.strips[0]!;

    const created = await postJson<ProductionOrderDto>(api, '/api/production', {
      productId: s.product.id,
      targetPieces: 900,
      notes: 'Corrida E2E de idempotencia M2',
    });
    await postJson<ProductionOrderDto>(api, `/api/production/${created.id}/consume`, {
      coilId: strip.id,
    });

    // Mismo intento contado dos veces: la clave la generaría el cliente una sola vez por
    // click. Sin D-182, esto habría consumido 2 000 kg de fleje y sumado 1 000 piezas en
    // vez de 500.
    const idempotencyKey = randomUUID();
    const [r1, r2] = await Promise.all([
      api.post(`/api/production/${created.id}/report`, { data: { pieces: 500, idempotencyKey } }),
      api.post(`/api/production/${created.id}/report`, { data: { pieces: 500, idempotencyKey } }),
    ]);
    expect(r1.ok(), 'el primer intento de un reporte con clave nueva debe pasar').toBe(true);
    expect(
      r2.ok(),
      'el segundo NO es un error: es el mismo intento, y debe devolver el mismo resultado',
    ).toBe(true);

    const body1 = (await r1.json()) as ProductionOrderDto;
    const body2 = (await r2.json()) as ProductionOrderDto;
    expect(body1.piecesReported).toBe(500);
    expect(body2.piecesReported).toBe(500);
    expect(body1.reports, 'un solo reporte, no dos, para el mismo intento').toHaveLength(1);

    // 2 400 kg de fleje − 1 000 kg (500 piezas × 2 kg/pieza) = 1 400 kg, una sola vez.
    expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('1400.000');
    expect((await balanceOf(api, 'PRODUCT', s.product.id)).qty).toBe('500.000');
  });

  test('registrar un pago a proveedor dos veces con la misma clave no duplica el cobro', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api, { name: 'E2E Proveedor pago concurrente' });
    const purchase = await postJson<{ id: string; balance: string; total: string }>(
      api,
      '/api/purchases',
      {
        supplierId: supplier.id,
        businessLine: 'services',
        type: 'SERVICE',
        docType: 'FACTURA',
        series: 'F001',
        number: uniqueDocumentNumber(),
        issueDate: today(),
        currency: 'PEN',
        igvRate: '18',
        paymentTerms: 'CONTADO',
        serviceKind: 'FREIGHT',
        items: [
          { description: 'Servicio E2E M2 idempotencia', qty: '1', unit: 'ZZ', unitPrice: '10000' },
        ],
      },
    );
    expect(purchase.total).toBe('11800.0000');
    expect(purchase.balance).toBe('11800.0000');

    const idempotencyKey = randomUUID();
    const paymentBody = {
      date: today(),
      amount: '5000',
      currency: 'PEN',
      method: 'TRANSFER',
      reference: 'E2E-M2-IDEMPOTENCIA',
      idempotencyKey,
    };
    const [r1, r2] = await Promise.all([
      api.post(`/api/purchases/${purchase.id}/payments`, { data: paymentBody }),
      api.post(`/api/purchases/${purchase.id}/payments`, { data: paymentBody }),
    ]);
    expect(r1.ok()).toBe(true);
    expect(r2.ok(), 'el segundo es el mismo intento, no un pago nuevo').toBe(true);

    // 11 800 − 5 000 = 6 800: si el pago se hubiera duplicado, quedaría en 1 800.
    const reloaded = await getJson<{ balance: string; payments: unknown[] }>(
      api,
      `/api/purchases/${purchase.id}`,
    );
    expect(reloaded.balance).toBe('6800.0000');
    expect(reloaded.payments, 'un solo pago, no dos, para el mismo intento').toHaveLength(1);
  });
});
