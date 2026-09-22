import { test, expect } from '@playwright/test';
import { businessToday } from '@ayr/shared';
import { adminApi, createUser } from '../helpers/api';
import { createCustomer, setupCoilStock, createSellableProduct } from '../helpers/sales';
import { apiAs } from '../helpers/production';

test.describe('Acceso Supervisor de Planta (CRITICA 1)', () => {
  test('SUPERVISOR_PLANTA puede operar punta a punta la OP de otro usuario y descargar hoja de planta', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);

    const vendedor = await createUser(api, 'VENDEDOR');
    const supervisor = await createUser(api, 'SUPERVISOR_PLANTA');

    const customer = await createCustomer(api);

    const { finish, coil } = await setupCoilStock(api, {
      lineCode: 'metallic-roofing',
      weightKg: '5000',
      thicknessMm: '0.45',
    });

    const productRes = await createSellableProduct(api, {
      lineCode: 'metallic-roofing',
      unit: 'MTR',
      roofingKind: 'A_MEDIDA',
      finishId: finish.id,
      thicknessMm: '0.45',
      listPricePen: '30',
    });

    const apiVen = await apiAs(baseURL!, vendedor);

    const quoteRes = await apiVen.post('/api/sales/quotations', {
      data: {
        customerId: customer.id,

        issueDate: businessToday(),
        items: [{ productId: productRes.id, qty: '30', pieces: [{ lengthMm: '3000', qty: 10 }] }],
      },
    });
    if (!quoteRes.ok()) {
      throw new Error('HTTP ' + quoteRes.status() + ' ' + (await quoteRes.text()));
    }
    const { id: quoteId } = await quoteRes.json();

    const confirmRes = await apiVen.post(`/api/sales/quotations/${quoteId}/confirm`);
    expect(confirmRes.ok()).toBeTruthy();
    const order = await confirmRes.json();
    const orderId = order.id;

    const productionOrderId = order.reservations[0].productionOrderId;
    expect(productionOrderId).toBeDefined();

    const apiSup = await apiAs(baseURL!, supervisor);

    const opsRes = await apiSup.get('/api/production/roofing/queue');
    expect(opsRes.ok()).toBeTruthy();

    const pdfRes = await apiSup.get(`/api/sales/orders/${orderId}/pdf-planta`);
    expect(pdfRes.ok()).toBeTruthy();

    const mountRes = await apiSup.post(`/api/production/roofing/${productionOrderId}/mount`, {
      data: { coilId: coil.id },
    });
    expect(mountRes.ok()).toBeTruthy();

    const piecesRes = await apiSup.post(`/api/production/roofing/${productionOrderId}/pieces`, {
      data: { reportedQty: 10, scrappedQty: 0, date: businessToday() },
    });
    expect(piecesRes.ok()).toBeTruthy();

    const closeRes = await apiSup.post(`/api/production/roofing/${productionOrderId}/close`, {
      data: { force: false },
    });
    expect(closeRes.ok()).toBeTruthy();
  });
});
