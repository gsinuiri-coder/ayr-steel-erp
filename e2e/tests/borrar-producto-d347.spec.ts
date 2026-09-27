import { expect, test } from '@playwright/test';
import { adminApi, createFinish, createUser, getJson } from '../helpers/api';
import { loginAndSetPassword, openSidebarGroup } from '../helpers/ui';
import { createSellableProduct, createCustomer, createQuotation } from '../helpers/sales';

/**
 * D-347/M6 — borrar físicamente un producto que nunca se usó.
 *
 * Dos caminos: un SKU cargado de más y sin historia se borra para siempre; uno con una
 * cotización detrás no se puede (el botón lo dice antes de intentarlo, y el API lo rechaza
 * igual si algo se salta la UI).
 */

test.skip(!!process.env.E2E_BASE_URL, 'Crea datos comerciales: nunca contra producción (D-126).');
test.describe.configure({ timeout: 180_000 });

test.describe('D-347 — borrado físico de un producto del catálogo', () => {
  test('nunca se usó: se borra para siempre', async ({ page, baseURL }) => {
    const api = await adminApi(baseURL!);
    const finish = await createFinish(api, { businessLine: 'metallic-roofing' });
    const product = await createSellableProduct(api, {
      lineCode: 'metallic-roofing',
      finishId: finish.id,
    });

    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, 'ClaveAdminE2E-2026');

    await openSidebarGroup(page, 'Catálogo');
    await page.getByRole('link', { name: 'Productos', exact: true }).click();
    await page.getByRole('tab', { name: 'Coberturas Aluzinc' }).click();
    const row = page.getByRole('row').filter({ hasText: product.sku });
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: `Más acciones de ${product.sku}` }).click();
    const deleteItem = page.getByRole('menuitem', { name: 'Eliminar' });
    await expect(deleteItem).toBeEnabled();
    await deleteItem.click();

    const dialog = page.getByRole('dialog', { name: new RegExp(`Borrar ${product.sku}`) });
    await expect(dialog).toContainText('no se puede deshacer');
    await dialog.getByRole('button', { name: `Borrar ${product.sku}` }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`${product.sku} borrado del catálogo`)).toBeVisible();
    await expect(row).toBeHidden();

    // El borrado es de verdad: el producto ya no existe, ni siquiera inactivo.
    const res = await api.get(`/api/catalog/${product.id}`);
    expect(res.status()).toBe(404);
  });

  test('con una cotización detrás: el menú lo bloquea y el API lo rechaza igual', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const finish = await createFinish(api, { businessLine: 'metallic-roofing' });
    const product = await createSellableProduct(api, {
      lineCode: 'metallic-roofing',
      finishId: finish.id,
      listPricePen: '50',
      roofingKind: 'PLANCHA',
    });
    const customer = await createCustomer(api);
    await createQuotation(api, {
      customerId: customer.id,
      businessLine: 'metallic-roofing',
      productId: product.id,
      qty: '3',
    });

    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, 'ClaveAdminE2E-2026');

    await openSidebarGroup(page, 'Catálogo');
    await page.getByRole('link', { name: 'Productos', exact: true }).click();
    await page.getByRole('tab', { name: 'Coberturas Aluzinc' }).click();
    const row = page.getByRole('row').filter({ hasText: product.sku });
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: `Más acciones de ${product.sku}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Eliminar' })).toBeDisabled();
    // Cierra el menú antes de intentar por API, para no dejarlo abierto sobre la siguiente
    // aserción (Radix lo cierra solo con Escape).
    await page.keyboard.press('Escape');

    // Alguien que se salte la UI también rebota, con el motivo nombrado.
    const res = await api.delete(`/api/catalog/${product.id}`);
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/cotización/);

    const stillThere = await getJson(api, `/api/catalog/${product.id}`);
    expect(stillThere).toMatchObject({ id: product.id });
  });
});
