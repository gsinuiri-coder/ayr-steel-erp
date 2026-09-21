import { expect, test } from '@playwright/test';
import { adminApi, createUser, getJson, postJson } from '../helpers/api';
import {
  createCustomer,
  setupCoilStock,
  createQuotation,
} from '../helpers/sales';
import { BusinessLineCode } from '@ayr/shared';

test.describe('Alcance Comercial de Vendedor (RF-S3c)', () => {
  test('matriz cruzada extendida por entidad', async ({
    baseURL,
    request,
  }) => {
    const api = await adminApi(baseURL!);

    const vendedorA = await createUser(api, 'VENDEDOR');
    const vendedorB = await createUser(api, 'VENDEDOR');
    const admin = await createUser(api, 'ADMINISTRADOR');

    const customerA = await createCustomer(api);
    const { productId } = await setupCoilStock(api, {
      businessLine: 'DRYWALL',
      code: 'ALC-VEN-1',
      thicknessMm: '0.45',
      widthMm: '1200',
      weightKg: '5000',
    });

    const contextA = await request.newContext();
    await contextA.post('/api/auth/login', { data: { email: vendedorA.email, password: vendedorA.password } });

    const contextB = await request.newContext();
    await contextB.post('/api/auth/login', { data: { email: vendedorB.email, password: vendedorB.password } });

    const contextAdmin = await request.newContext();
    await contextAdmin.post('/api/auth/login', { data: { email: admin.email, password: admin.password } });

    // 1. Crear cotización por Admin pero para Vendedor A
    const quoteA = await createQuotation(api, {
      customerId: customerA.id,
      businessLine: BusinessLineCode.DRYWALL,
      productId: productId,
      qty: '10'
    });
    
    // Asignar sellerId a vendedorA
    // It's easier if Vendedor A just creates the quotation
    const quoteRes = await contextA.post('/api/sales/quotations', {
      data: {
        customerId: customerA.id,
        businessLine: 'DRYWALL',
        issueDate: new Date().toISOString().slice(0, 10),
        items: [{ productId, qty: '10' }]
      }
    });
    expect(quoteRes.ok()).toBeTruthy();
    const myQuote = await quoteRes.json();
    const quoteId = myQuote.id;
    
    // duplicate
    await expect(contextB.post(`/api/sales/quotations/${quoteId}/duplicate`)).resolves.toMatchObject({ _initializer: { status: 404 } });
    
    // confirm-preview
    await expect(contextB.post(`/api/sales/quotations/${quoteId}/confirm-preview`)).resolves.toMatchObject({ _initializer: { status: 404 } });
    
    // confirm
    await expect(contextB.post(`/api/sales/quotations/${quoteId}/confirm`)).resolves.toMatchObject({ _initializer: { status: 404 } });
    
    // PDF de cotización
    await expect(contextB.get(`/api/sales/quotations/${quoteId}/pdf`)).resolves.toMatchObject({ _initializer: { status: 404 } });
    
    // reserva/liberación
    await expect(contextB.post(`/api/sales/quotations/${quoteId}/temporary-reservation`)).resolves.toMatchObject({ _initializer: { status: 404 } });
    await expect(contextB.post(`/api/sales/quotations/${quoteId}/release-reservation`, { data: { reason: 'TEST' } })).resolves.toMatchObject({ _initializer: { status: 404 } });

    // Admin SÍ puede duplicar
    const dupAdminRes = await contextAdmin.post(`/api/sales/quotations/${quoteId}/duplicate`);
    expect(dupAdminRes.ok()).toBeTruthy();

    // Confirmar cotización de A por A para crear OP y Pedido
    const confirmRes = await contextA.post(`/api/sales/quotations/${quoteId}/confirm`);
    expect(confirmRes.ok()).toBeTruthy();
    const orderA = await confirmRes.json();
    const orderId = orderA.id;

    // Vendedor B intenta acceder al pedido
    await expect(contextB.get(`/api/sales/orders/${orderId}`)).resolves.toMatchObject({ _initializer: { status: 404 } });
    
    // PDF de planta
    await expect(contextB.get(`/api/sales/orders/${orderId}/pdf-planta`)).resolves.toMatchObject({ _initializer: { status: 404 } });
    
    // Admin SÍ puede ver PDF de planta
    const pdfPlantaAdmin = await contextAdmin.get(`/api/sales/orders/${orderId}/pdf-planta`);
    expect(pdfPlantaAdmin.ok()).toBeTruthy();

    // OP (403)
    await expect(contextB.get(`/api/production/orders`)).resolves.toMatchObject({ _initializer: { status: 403 } });

    // 2. Kardex / Auditoría (403 para vendedor, 200 para admin)
    const kardexResA = await contextA.get('/api/inventory/movements');
    expect(kardexResA.status()).toBe(403);
    const kardexResAdmin = await contextAdmin.get('/api/inventory/movements');
    expect(kardexResAdmin.status()).toBe(200);

    const auditResA = await contextA.get('/api/audit/logs');
    expect(auditResA.status()).toBe(403);
    const auditResAdmin = await contextAdmin.get('/api/audit/logs');
    expect(auditResAdmin.status()).toBe(200);

    // 3. Stock / Modal de cotización (200, sin costos)
    const resA = await contextA.get('/api/inventory/balances');
    expect(resA.ok()).toBeTruthy();
    const balances = await resA.json();
    expect(balances.data.length).toBeGreaterThan(0);
    for (const b of balances.data) {
      expect(b.avgCostPen).toBeNull();
      expect(b.totalValuePen).toBeNull();
    }

    const coilResA = await contextA.get('/api/coils');
    expect(coilResA.ok()).toBeTruthy();
    const coils = await coilResA.json();
    expect(coils.data.length).toBeGreaterThan(0);
    for (const c of coils.data) {
      expect(c.unitCostPerKg).toBeNull();
      expect(c.totalCostPen).toBeNull();
    }
  });
});
