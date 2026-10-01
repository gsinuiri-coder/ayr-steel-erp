import { expect, test, type APIRequestContext } from '@playwright/test';
import type { PurchaseDto } from '@ayr/shared';
import { adminApi, adminCredentials, createSupplier, getJson, postJson } from '../helpers/api';
import { today } from '../helpers/production';

/**
 * D-371 — corregir o quitar líneas de una compra en borrador (sin kardex): cantidad y costo
 * unitario, totales recalculados, nunca la última línea, nunca con pagos vigentes ni ya
 * recibida. Un gasto (`EXPENSE`) basta: no mueve inventario ni al recibirse.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea y anula compras: nunca contra producción (D-126).');
test.describe.configure({ timeout: 120_000 });

async function draftExpense(api: APIRequestContext, supplierId: string): Promise<PurchaseDto> {
  return postJson<PurchaseDto>(api, '/api/purchases', {
    supplierId,
    businessLine: 'drywall',
    type: 'EXPENSE',
    docType: 'FACTURA',
    series: 'F371',
    number: String(Math.floor(Math.random() * 9_000_000) + 1_000_000),
    issueDate: today(),
    currency: 'PEN',
    igvRate: '18',
    paymentTerms: 'CONTADO',
    items: [
      { description: 'Gasto E2E línea uno', qty: '2', unit: 'ZZ', unitPrice: '100' },
      { description: 'Gasto E2E línea dos', qty: '1', unit: 'ZZ', unitPrice: '50' },
    ],
  });
}

test.describe('D-371 — líneas de una compra en borrador', () => {
  let api: APIRequestContext;
  const toCancel: string[] = [];

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    for (const id of toCancel) {
      await api
        .post(`/api/purchases/${id}/cancel`, { data: { reason: 'Limpieza del E2E D-371' } })
        .catch(() => undefined);
    }
    await api.dispose();
  });

  test('API: editar recalcula, la última no se quita, con pago o recibida se rechaza', async () => {
    const supplier = await createSupplier(api);
    const purchase = await draftExpense(api, supplier.id);
    toCancel.push(purchase.id);
    const [first, second] = purchase.items;

    // Editar: 3 × 120 = 360 + IGV 64.80; con la otra línea (50 + 9) la compra queda en 483.80.
    const edited = await api.patch(`/api/purchases/${purchase.id}/items/${first!.id}`, {
      data: { qty: '3', unitPrice: '120' },
    });
    expect(edited.status()).toBe(200);
    const afterEdit = (await edited.json()) as PurchaseDto;
    expect(afterEdit.items[0]).toMatchObject({ qty: '3.000', unitPrice: '120.0000' });
    expect(afterEdit.total).toBe('483.8000');

    // Quitar la primera: la segunda pasa a ser la línea 1 y queda sola.
    const removed = await api.delete(`/api/purchases/${purchase.id}/items/${first!.id}`);
    expect(removed.status()).toBe(200);
    const afterDelete = (await removed.json()) as PurchaseDto;
    expect(afterDelete.items.map((i) => [i.id, i.lineNumber])).toEqual([[second!.id, 1]]);
    expect(afterDelete.total).toBe('59.0000');

    const last = await api.delete(`/api/purchases/${purchase.id}/items/${second!.id}`);
    expect(last.status()).toBe(400);
    expect(await last.text()).toContain('única línea');

    // Con un pago vigente no se edita.
    const paid = await draftExpense(api, supplier.id);
    toCancel.push(paid.id);
    await postJson(api, `/api/purchases/${paid.id}/payments`, {
      date: today(),
      amount: '10',
      currency: 'PEN',
      method: 'CASH',
    });
    const withPayment = await api.patch(`/api/purchases/${paid.id}/items/${paid.items[0]!.id}`, {
      data: { qty: '1', unitPrice: '1' },
    });
    expect(withPayment.status()).toBe(400);
    expect(await withPayment.text()).toContain('pagos registrados');

    // Recibida: ya no es un borrador.
    const received = await draftExpense(api, supplier.id);
    toCancel.push(received.id);
    await postJson(api, `/api/purchases/${received.id}/receive`, {});
    const onReceived = await api.delete(
      `/api/purchases/${received.id}/items/${received.items[0]!.id}`,
    );
    expect(onReceived.status()).toBe(400);
    expect(await onReceived.text()).toContain('recibida');
    const unchanged = await getJson<PurchaseDto>(api, `/api/purchases/${received.id}`);
    expect(unchanged.items).toHaveLength(2);
  });

  test('pantalla: editar una línea del borrador y ver el total recalculado', async ({ page }) => {
    const supplier = await createSupplier(api);
    const purchase = await draftExpense(api, supplier.id);
    toCancel.push(purchase.id);

    const { email, password } = adminCredentials();
    await page.goto('/login');
    await page.getByLabel('Correo electrónico').fill(email);
    await page.getByLabel('Contraseña', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Ingresar' }).click();
    await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });

    await page.goto(`/compras/${purchase.id}`);
    await expect(page.getByTestId('linea-compra')).toHaveCount(2, { timeout: 60_000 });
    await page.getByRole('button', { name: 'Editar la línea 1', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Cantidad/).fill('3');
    await dialog.getByLabel('Precio unitario sin IGV').fill('120');
    await dialog.getByRole('button', { name: 'Guardar' }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(async () => (await getJson<PurchaseDto>(api, `/api/purchases/${purchase.id}`)).total)
      .toBe('483.8000');
    await expect(page.getByTestId('linea-compra').first()).toContainText('360.00');

    await page.getByRole('button', { name: 'Eliminar la línea 2', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sí, eliminar' }).click();
    await expect(page.getByTestId('linea-compra')).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: 'Eliminar la línea 1', exact: true }),
    ).toBeDisabled();
  });
});
