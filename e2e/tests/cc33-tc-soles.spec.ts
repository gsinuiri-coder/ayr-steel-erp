import { FINISH_FIELD_LABEL, type PurchaseDto } from '@ayr/shared';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  adminApi,
  createFinish,
  createSupplier,
  createUser,
  finishOptionLabel,
  getItems,
  getJson,
  postJson,
} from '../helpers/api';
import { today } from '../helpers/production';
import { loginAndSetPassword, selectOption } from '../helpers/ui';

/**
 * cc33 N1 — una compra en soles va siempre con TC 1. Antes el API tomaba el TC explícito antes
 * que la regla de los soles, y el formulario escondía el campo al volver a soles pero seguía
 * mandando lo último que se escribió: la recepción multiplicaba el costo de la bobina por ese TC.
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea y recibe compras: nunca contra producción (D-126).');
test.describe.configure({ timeout: 120_000 });

const ADMIN_PASSWORD = 'ClaveAdminE2E-2026';

interface CoilDto {
  id: string;
  purchaseId: string | null;
  currency: string;
  exchangeRate: string | null;
  totalCostPen: string;
}

function uniqueNumber(): string {
  return String(Date.now()).slice(-9);
}

test.describe('cc33 N1 — TC de una compra en soles', () => {
  let api: APIRequestContext;
  const toCancel: string[] = [];

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    for (const id of toCancel) {
      await api
        .post(`/api/purchases/${id}/cancel`, { data: { reason: 'Limpieza del E2E cc33' } })
        .catch(() => undefined);
    }
    await api.dispose();
  });

  test('API: soles con TC 3.75 se rechaza; un pago en soles guarda TC 1', async () => {
    const supplier = await createSupplier(api);
    const body = {
      supplierId: supplier.id,
      businessLine: 'drywall',
      type: 'EXPENSE',
      docType: 'FACTURA',
      series: 'F033',
      number: uniqueNumber(),
      issueDate: today(),
      currency: 'PEN',
      exchangeRate: '3.75',
      igvRate: '18',
      paymentTerms: 'CONTADO',
      items: [{ description: 'Gasto E2E cc33', qty: '1', unit: 'ZZ', unitPrice: '100' }],
    };
    const rejected = await api.post('/api/purchases', { data: body });
    expect(rejected.status()).toBe(400);
    expect(await rejected.text()).toContain('tipo de cambio 1');

    const purchase = await postJson<PurchaseDto>(api, '/api/purchases', {
      ...body,
      exchangeRate: undefined,
    });
    toCancel.push(purchase.id);
    expect(purchase.exchangeRate).toBe('1.0000');
    const paid = await postJson<PurchaseDto>(api, `/api/purchases/${purchase.id}/payments`, {
      date: today(),
      amount: '10',
      currency: 'PEN',
      exchangeRate: '3.75',
      method: 'CASH',
    });
    expect(paid.payments[0]).toMatchObject({ currency: 'PEN', exchangeRate: '1.0000' });
    // Una compra con pago vigente no se anula: el pago se anula primero para que la limpieza
    // del `afterAll` no falle en silencio.
    await postJson(api, `/api/purchases/${purchase.id}/payments/${paid.payments[0]!.id}/reverse`, {
      reason: 'Limpieza del E2E cc33',
    });
  });

  test('pantalla: pasar de dólares a soles limpia el TC y la bobina entra al costo del subtotal', async ({
    page,
  }) => {
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);

    await page.goto('/compras/nueva?tipo=COIL');
    await expect(page.getByRole('heading', { name: 'Nueva compra' })).toBeVisible();
    await selectOption(
      page,
      page.getByRole('combobox', { name: 'Proveedor' }),
      `${supplier.code} — ${supplier.name}`,
    );
    await page.getByLabel('Serie').fill('F033');
    await page.getByLabel('Número').fill(uniqueNumber());

    // Dólares con un TC escrito a mano, y de vuelta a soles: el campo se esconde.
    await selectOption(page, page.getByRole('combobox', { name: 'Moneda' }), 'Dólares (USD)');
    await page.getByLabel('Tipo de cambio').fill('3.75');
    await selectOption(page, page.getByRole('combobox', { name: 'Moneda' }), 'Soles (PEN)');
    await expect(page.getByLabel('Tipo de cambio')).toHaveCount(0);

    await selectOption(
      page,
      page.getByRole('combobox', { name: FINISH_FIELD_LABEL }).first(),
      finishOptionLabel(finish),
    );
    await page.getByLabel('Descripción').first().fill('Bobina E2E cc33');
    await page.getByLabel('Ancho', { exact: true }).first().fill('1200');
    await page.getByLabel('Espesor', { exact: true }).first().fill('0.5');
    await page.getByLabel('Peso', { exact: true }).first().fill('1000');
    await page.getByLabel('Precio por kg').first().fill('4');

    await page.getByRole('button', { name: 'Registrar compra' }).click();
    await expect(page.getByText('Compra registrada')).toBeVisible();
    await page.waitForURL(/\/compras\/[0-9a-f-]{36}$/);
    const purchaseId = page.url().split('/').pop() ?? '';
    toCancel.push(purchaseId);

    const draft = await getJson<PurchaseDto>(api, `/api/purchases/${purchaseId}`);
    expect(draft).toMatchObject({ currency: 'PEN', exchangeRate: '1.0000' });
    expect(draft.totalPen).toBe(draft.total);

    await postJson(api, `/api/purchases/${purchaseId}/receive`, {});
    const coils = await getItems<CoilDto>(api, `/api/coils?supplierId=${supplier.id}`);
    const coil = coils.find((c) => c.purchaseId === purchaseId);
    // 1000 kg × S/ 4 = S/ 4000 sin IGV: el costo de la bobina es el subtotal, sin multiplicar.
    expect(coil?.totalCostPen).toBe('4000.0000');
  });
});
