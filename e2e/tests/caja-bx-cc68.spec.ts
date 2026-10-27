import { expect, test } from '@playwright/test';
import type { ConfirmPreviewDto, ProductDto, QuotationDto } from '@ayr/shared';
import { adminApi, createUser, getJson } from '../helpers/api';
import { loginAndSetPassword, openSidebarGroup, selectOption } from '../helpers/ui';
import {
  createCustomer,
  createQuotation,
  createSellableProduct,
  updateQuotationBody,
} from '../helpers/sales';

/**
 * cc68 — la unidad como lista cerrada (D-723) y la caja (D-724).
 *
 * - El diálogo de producto elige la unidad de la lista; «Caja (BX)» se ve «caja» en el catálogo.
 * - Una cotización emitida en NIU de un producto que después pasó a BX no se confirma: la vista
 *   previa lo dice y la confirmación lo rechaza; editarla con la misma cantidad y el mismo precio
 *   la pasa a BX y deja de bloquear.
 *
 * Escribe datos: nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Suite local y CI: nunca contra producción (D-126).');

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );

test.describe('cc68 — unidad de la lista y caja (BX)', () => {
  test('el diálogo elige la unidad de la lista y la caja se ve «caja»', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const user = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, user, 'ClaveCajaE2E-2026');
    const sku = `CJ-CC68${letters(6)}`;

    await openSidebarGroup(page, 'Catálogo');
    await page.getByRole('link', { name: 'Productos', exact: true }).click();
    await page.getByRole('tab', { name: 'Reventa' }).click();
    await page.getByRole('button', { name: 'Nuevo producto' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('SKU').fill(sku);
    await dialog.getByLabel('Nombre').fill('Esquinero por caja E2E');
    // Ya no es texto libre: un selector con la lista del catálogo 03.
    await dialog.getByLabel('Unidad').click();
    await expect(page.getByRole('option', { name: 'Caja (BX)' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Unidad (NIU)' })).toBeVisible();
    await page.getByRole('option', { name: 'Caja (BX)' }).click();
    await selectOption(page, dialog.getByLabel('Origen'), 'Comprado');
    await dialog.getByRole('button', { name: 'Crear producto' }).click();
    await expect(dialog).toBeHidden();

    const row = page.getByRole('row').filter({ hasText: sku });
    await expect(row).toBeVisible();
    await expect(row.getByRole('cell', { name: 'caja', exact: true })).toBeVisible();
    const products = await getJson<ProductDto[]>(api, '/api/catalog');
    expect(products.find((p) => p.sku === sku)?.unit).toBe('BX');
  });

  test('una cotización en NIU de un producto que pasó a BX no se confirma hasta editarla', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const customer = await createCustomer(api);
    const product = await createSellableProduct(api, { lineCode: 'trading', listPricePen: '140' });
    const quotation = await createQuotation(api, {
      customerId: customer.id,
      businessLine: 'trading',
      productId: product.id,
      qty: '4',
      unitPricePen: '118.6440',
    });
    expect(quotation.items[0]?.unit).toBe('NIU');

    // El producto pasa a cajas (sin kardex, como ESQ30 después de anular su carga).
    const patched = await api.patch(`/api/catalog/${product.id}`, { data: { unit: 'BX' } });
    expect(patched.ok(), await patched.text()).toBe(true);

    const message =
      /Línea 1: .* se cotizó en Unidad \(NIU\) y hoy se vende en Caja \(BX\): edita la cotización/;
    const preview = await getJson<ConfirmPreviewDto>(
      api,
      `/api/sales/quotations/${quotation.id}/confirm-preview`,
    );
    expect(preview.blockers.join(' ')).toMatch(message);
    const confirm = await api.post(`/api/sales/quotations/${quotation.id}/confirm`, { data: {} });
    expect(confirm.status()).toBe(400);
    expect(await confirm.text()).toMatch(message);

    // Editar con la misma cantidad y el mismo precio la pasa a BX; nada más cambia.
    const edited = await api.put(`/api/sales/quotations/${quotation.id}`, {
      data: updateQuotationBody({
        customerId: customer.id,
        issueDate: quotation.issueDate,
        items: [{ productId: product.id, qty: '4', unitPricePen: '118.6440' }],
      }),
    });
    expect(edited.ok(), await edited.text()).toBe(true);
    const after = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
    expect(after.items[0]).toMatchObject({ unit: 'BX', qty: quotation.items[0]?.qty });
    expect(after.items[0]?.unitPricePen).toBe(quotation.items[0]?.unitPricePen);
    expect(after.totalPen).toBe(quotation.totalPen);
    expect(after.status).toBe(quotation.status);
    expect(after.validUntil).toBe(quotation.validUntil);
    expect(after.customerId).toBe(customer.id);

    const again = await getJson<ConfirmPreviewDto>(
      api,
      `/api/sales/quotations/${quotation.id}/confirm-preview`,
    );
    expect(again.blockers.join(' ')).not.toMatch(/se cotizó en/);
  });
});
