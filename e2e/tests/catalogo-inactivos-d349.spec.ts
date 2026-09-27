import { expect, test } from '@playwright/test';
import { adminApi, createFinish, createUser } from '../helpers/api';
import { loginAndSetPassword, openSidebarGroup } from '../helpers/ui';
import { createSellableProduct } from '../helpers/sales';

/**
 * D-349 — el catálogo oculta los productos inactivos por defecto. El chip «Inactivos» los muestra
 * (y queda en la URL, D-289); buscar por SKU los encuentra aunque el chip esté apagado.
 */

test.skip(!!process.env.E2E_BASE_URL, 'Crea datos de catálogo: nunca contra producción (D-126).');
test.describe.configure({ timeout: 180_000 });

test('D-349 — inactivos ocultos por defecto, visibles con el chip o buscando el SKU', async ({
  page,
  baseURL,
}) => {
  const api = await adminApi(baseURL!);
  const finish = await createFinish(api, { businessLine: 'metallic-roofing' });
  const product = await createSellableProduct(api, {
    lineCode: 'metallic-roofing',
    finishId: finish.id,
  });
  await api.patch(`/api/catalog/${product.id}`, { data: { isActive: false } });

  const admin = await createUser(api, 'ADMINISTRADOR');
  await loginAndSetPassword(page, admin, 'ClaveAdminE2E-2026');
  await openSidebarGroup(page, 'Catálogo');
  await page.getByRole('link', { name: 'Productos', exact: true }).click();
  await page.getByRole('tab', { name: 'Coberturas Aluzinc' }).click();
  const row = page.getByRole('row').filter({ hasText: product.sku });
  const chip = page.getByRole('button', { name: 'Inactivos', exact: true });

  // Por defecto el inactivo no aparece.
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await expect(row).toBeHidden();

  // Buscando su SKU aparece aunque el chip esté apagado.
  await page.getByLabel('Buscar productos por SKU o nombre').fill(product.sku);
  await expect(row).toBeVisible();
  await expect(row).toContainText('Inactivo');
  await page.getByLabel('Buscar productos por SKU o nombre').fill('');
  await expect(row).toBeHidden();

  // El chip lo muestra y el estado queda en la URL: recargar lo conserva.
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/inactivos=1/);
  await expect(row).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Coberturas Aluzinc' }).click();
  await expect(page.getByRole('button', { name: 'Inactivos', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(row).toBeVisible();

  // El API filtra igual si se lo piden.
  const active = await api.get('/api/catalog?active=true');
  expect(((await active.json()) as { id: string }[]).some((p) => p.id === product.id)).toBe(false);
  const inactive = await api.get('/api/catalog?active=false');
  expect(((await inactive.json()) as { id: string }[]).some((p) => p.id === product.id)).toBe(true);
});
