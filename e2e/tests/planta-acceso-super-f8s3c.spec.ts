import { test, expect } from '@playwright/test';
import { businessToday } from '@ayr/shared';
import { adminApi, createUser } from '../helpers/api';
import { createCustomer, setupCoilStock } from '../helpers/sales';

test.describe('Acceso Supervisor de Planta (CRÍTICA 1)', () => {
  test('SUPERVISOR_PLANTA puede operar punta a punta la OP de otro usuario y descargar hoja de planta', async ({
    baseURL,
    request,
  }) => {
    const api = await adminApi(baseURL!);

    const vendedor = await createUser(api, 'VENDEDOR');
    const supervisor = await createUser(api, 'SUPERVISOR_PLANTA');

    const customer = await createCustomer(api);

    const { productId, coilId } = await setupCoilStock(api, {
      businessLine: 'ROOFING',
      code: 'PLN-SUP-1',
      thicknessMm: '0.45',
      widthMm: '1200',
      weightKg: '5000',
    });

    // 1. Vendedor crea cotización y la confirma
    const contextVen = await request.newContext();
    await contextVen.post('/api/auth/login', {
      data: { email: vendedor.email, password: vendedor.password },
    });

    const quoteRes = await contextVen.post('/api/sales/quotations', {
      data: {
        customerId: customer.id,
        businessLine: 'ROOFING',
        issueDate: businessToday(),
        items: [{ productId, qty: '10', lengthMeters: '3.00' }],
      },
    });
    expect(quoteRes.ok()).toBeTruthy();
    const { id: quoteId } = await quoteRes.json();

    const confirmRes = await contextVen.post(`/api/sales/quotations/${quoteId}/confirm`);
    expect(confirmRes.ok()).toBeTruthy();
    const order = await confirmRes.json();
    const orderId = order.id;

    // Obtener el ID de la orden de producción desde la reserva del vendedor
    const productionOrderId = order.reservations[0].productionOrderId;
    expect(productionOrderId).toBeDefined();

    // 2. Supervisor de Planta (actor de la prueba)
    const contextSup = await request.newContext();
    await contextSup.post('/api/auth/login', {
      data: { email: supervisor.email, password: supervisor.password },
    });

    // Supervisor lista la cola de planta (debería verla y no tener 403 ni 404)
    const opsRes = await contextSup.get('/api/production/orders');
    expect(opsRes.ok()).toBeTruthy();

    // Supervisor descarga la hoja de planta
    const pdfRes = await contextSup.get(`/api/sales/orders/${orderId}/pdf-planta`);
    expect(pdfRes.ok()).toBeTruthy();

    // Supervisor monta la bobina
    const mountRes = await contextSup.post(`/api/production/${productionOrderId}/mount`, {
      data: { coilId },
    });
    expect(mountRes.ok()).toBeTruthy();

    // Supervisor reporta piezas
    const piecesRes = await contextSup.post(`/api/production/${productionOrderId}/pieces`, {
      data: { good: 10, scrap: 0, date: businessToday(), reportScrap: false },
    });
    expect(piecesRes.ok()).toBeTruthy();

    // Supervisor cierra la OP
    const closeRes = await contextSup.post(`/api/production/${productionOrderId}/close`, {
      data: { force: false },
    });
    expect(closeRes.ok()).toBeTruthy();

    // El supervisor pudo hacer todo el flujo sin que "assertSellerAccess" lo bloqueara
  });
});
