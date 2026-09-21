import { expect, test } from '@playwright/test';
import { adminApi, createUser } from '../helpers/api';
import { createCustomer, createQuotation, confirmQuotation } from '../helpers/sales';
import { loginAndSetPassword } from '../helpers/ui';

test.describe('Alcance Comercial de Vendedor (RF-S3c)', () => {
  test('matriz cruzada por entidad, UI y URL directa entre Vendedor A, Vendedor B y Admin', async ({
    browser,
    baseURL,
    request,
  }) => {
    const api = await adminApi(baseURL!);
    
    // Create users
    const vendedorA = await createUser(api, 'VENDEDOR');
    const vendedorB = await createUser(api, 'VENDEDOR');
    const admin = await createUser(api, 'ADMINISTRADOR');

    // Create a customer
    const customer = await createCustomer(api, {
      name: 'CLIENTE E2E ALCANCE',
      docNumber: `20${Date.now()}`.slice(0, 11),
      docType: 'RUC',
    });

    // We can use api contexts authenticated as each user
    const contextA = await request.newContext();
    const loginResA = await contextA.post('/api/auth/login', {
      data: { email: vendedorA.email, password: vendedorA.password },
    });
    expect(loginResA.status()).toBe(200);

    const contextB = await request.newContext();
    const loginResB = await contextB.post('/api/auth/login', {
      data: { email: vendedorB.email, password: vendedorB.password },
    });
    expect(loginResB.status()).toBe(200);

    // Get an active product
    const productsRes = await api.get('/api/catalog');
    const products = await productsRes.json();
    const product = products.find((p: any) => p.status === 'ACTIVE' && p.businessLine === 'DRYWALL');
    
    // Create quotation for Vendedor A
    const resQA = await contextA.post('/api/sales/quotations', {
      data: {
        customerId: customer.id,
        currency: 'PEN',
        lines: [
          {
            productId: product.id,
            quantity: 10,
            unitPrice: '100',
            description: 'Item A',
            isMadeToMeasure: false,
            needsPieces: false,
          },
        ],
      },
    });
    expect(resQA.status()).toBe(201);
    const quotationA = await resQA.json();

    // Create quotation for Vendedor B
    const resQB = await contextB.post('/api/sales/quotations', {
      data: {
        customerId: customer.id,
        currency: 'PEN',
        lines: [
          {
            productId: product.id,
            quantity: 5,
            unitPrice: '200',
            description: 'Item B',
            isMadeToMeasure: false,
            needsPieces: false,
          },
        ],
      },
    });
    expect(resQB.status()).toBe(201);
    const quotationB = await resQB.json();

    // 1. Direct URL isolation checks
    
    // A sees A
    expect((await contextA.get(`/api/sales/quotations/${quotationA.id}`)).status()).toBe(200);
    // B sees B
    expect((await contextB.get(`/api/sales/quotations/${quotationB.id}`)).status()).toBe(200);
    
    // A cannot see B
    expect((await contextA.get(`/api/sales/quotations/${quotationB.id}`)).status()).toBe(404);
    // B cannot see A
    expect((await contextB.get(`/api/sales/quotations/${quotationA.id}`)).status()).toBe(404);

    // Admin sees both
    expect((await api.get(`/api/sales/quotations/${quotationA.id}`)).status()).toBe(200);
    expect((await api.get(`/api/sales/quotations/${quotationB.id}`)).status()).toBe(200);

    // Admin confirms Quotation A to create Order A
    const confirmRes = await api.post(`/api/sales/quotations/${quotationA.id}/confirm`, {
      data: {},
    });
    expect(confirmRes.status()).toBe(201);
    const orderA = await confirmRes.json();

    // Verify order A is still owned by A and visible to A
    expect((await contextA.get(`/api/sales/orders/${orderA.id}`)).status()).toBe(200);
    // B cannot see order A
    expect((await contextB.get(`/api/sales/orders/${orderA.id}`)).status()).toBe(404);

    // 2. UI isolation checks

    // Vendedor A UI
    const pageA = await browser.newPage();
    await loginAndSetPassword(pageA, vendedorA, 'Clave-A-2026');
    await pageA.goto('/cotizaciones');
    await expect(pageA.locator(`text=${quotationA.code}`).first()).toBeVisible();
    await expect(pageA.locator(`text=${quotationB.code}`).first()).not.toBeVisible();
    await pageA.close();

    // Vendedor B UI
    const pageB = await browser.newPage();
    await loginAndSetPassword(pageB, vendedorB, 'Clave-B-2026');
    await pageB.goto('/cotizaciones');
    await expect(pageB.locator(`text=${quotationB.code}`).first()).toBeVisible();
    await expect(pageB.locator(`text=${quotationA.code}`).first()).not.toBeVisible();
    await pageB.close();

    // Admin UI
    const pageAdmin = await browser.newPage();
    await loginAndSetPassword(pageAdmin, admin, 'Clave-Admin-2026');
    await pageAdmin.goto('/cotizaciones');
    await expect(pageAdmin.locator(`text=${quotationA.code}`).first()).toBeVisible();
    await expect(pageAdmin.locator(`text=${quotationB.code}`).first()).toBeVisible();
    await pageAdmin.close();
  });
});
