import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createUser } from '../helpers/api';
import { apiAs } from '../helpers/production';
import { createCustomer, patchExpectingError, queueOf, setPriority } from '../helpers/sales';
import { pieces, purgeRoofingTrail, quoteAndOrder, setupRoofingScenario } from '../helpers/roofing';

/**
 * Fase 7 — bordes de la cola de producción (RF-37, RF-38; D-092..D-096).
 *
 * `fase7.spec.ts` prueba que la cola entra y sale bien; este prueba que **nadie la mueve sin
 * dejar rastro**: el motivo es obligatorio en los dos sentidos de la prioridad, y solo
 * ADMINISTRADOR tiene la mano en ese botón.
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;

test.describe.configure({ timeout: 180_000 });

test.describe('Fase 7 — bordes de la cola de producción', () => {
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

  test('poner y quitar la prioridad exige motivo en los dos sentidos (D-094)', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '300' });
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
      const { order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '20',
        rows: pieces([2, 1]),
      });
      trail.orderIds = [order.id];

      // Priorizar sin motivo: el schema lo exige siempre, no solo al quitarla.
      const sinMotivoAlPoner = await patchExpectingError(
        api,
        `/api/sales/orders/${order.id}/priority`,
        { priority: true, reason: '' },
      );
      expect(sinMotivoAlPoner.status).toBe(400);

      // Con motivo válido sí prioriza.
      const prioritized = await setPriority(api, order.id, {
        priority: true,
        reason: 'Motivo válido de prueba E2E',
      });
      expect(prioritized.priority).toBe(true);

      // Quitarla también exige motivo: un `false` no es "sin comentarios".
      const sinMotivoAlQuitar = await patchExpectingError(
        api,
        `/api/sales/orders/${order.id}/priority`,
        { priority: false, reason: '' },
      );
      expect(sinMotivoAlQuitar.status).toBe(400);

      // Motivo demasiado corto: el mínimo de `reasonSchema` (3 caracteres) también aplica acá.
      const motivoCorto = await patchExpectingError(
        api,
        `/api/sales/orders/${order.id}/priority`,
        { priority: false, reason: 'ab' },
      );
      expect(motivoCorto.status).toBe(400);

      // Y sigue priorizado: ningún intento fallido tocó nada.
      expect((await queueOf(api)).find((q) => q.salesOrderId === order.id)?.priority).toBe(true);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('solo ADMINISTRADOR fija prioridad y fecha prometida; VENDEDOR lee la cola pero no la toca', async ({
    baseURL,
  }) => {
    const scenario = await setupRoofingScenario(api, { weightKg: '300' });
    const customer = await createCustomer(api);
    const seller = await createUser(api, 'VENDEDOR');
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
    let sellerApi: APIRequestContext | null = null;

    try {
      const { order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        coilId: scenario.coil.id,
        reserveKg: '20',
        rows: pieces([2, 1]),
      });
      trail.orderIds = [order.id];

      sellerApi = await apiAs(baseURL!, seller);

      // VENDEDOR sí puede leer la cola (RF-37: es la entrada de su propio panel).
      const queueAsSeller = await sellerApi.get('/api/sales/orders/queue');
      expect(queueAsSeller.ok()).toBe(true);

      // Pero no puede tocar la prioridad ni la fecha prometida: eso es de ADMINISTRADOR.
      const priorityAsSeller = await sellerApi.patch(`/api/sales/orders/${order.id}/priority`, {
        data: { priority: true, reason: 'Intento de un vendedor' },
      });
      expect(priorityAsSeller.status()).toBe(403);

      const dateAsSeller = await sellerApi.patch(
        `/api/sales/orders/${order.id}/promised-delivery-date`,
        { data: { promisedDeliveryDate: '2030-01-01' } },
      );
      expect(dateAsSeller.status()).toBe(403);
    } finally {
      await sellerApi?.dispose();
      await purgeRoofingTrail(api, trail);
    }
  });
});
