import { expect, test, type Page } from '@playwright/test';
import {
  INVENTORY_VALUATION_LINES,
  SALES_MARGIN_LINES,
  businessToday,
  sum,
  toDecimal,
  type InventoryValuationDto,
  type SalesMarginDto,
} from '@ayr/shared';
import { adminApi, adminCredentials, getJson } from '../helpers/api';

/**
 * cc23 (D-390..D-396) — reportes por línea de negocio con la pestaña en la URL.
 *
 * - Las pestañas de ventas y margen e inventario valorizado: «Todas» primera, una por línea de
 *   la matriz (D-391), y nada para lo que no aplica (D-394).
 * - Cambiar de pestaña entra al historial y conserva el rango; refrescar y retroceder vuelven
 *   al mismo estado; una línea inválida cae a «Todas» y corrige la URL (D-395).
 * - La API valida la línea contra la matriz y las pestañas suman «Todas» con los datos que haya
 *   en la base (la prueba exacta, con casos armados, está en los unitarios de la API).
 *
 * Solo lee, pero entra como administrador de la suite: nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Suite local y CI: nunca contra producción (D-126).');

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

function tab(page: Page, name: string) {
  return page.getByTestId('pestanas-linea').getByRole('tab', { name, exact: true });
}

const FROM = '2026-01-01';

test.describe('Reportes por línea (cc23)', () => {
  test('ventas y margen: pestañas, historial, refrescar y Servicios sin costo', async ({
    page,
  }) => {
    const to = businessToday();
    await loginAsAdmin(page);
    await page.goto(`/reportes/ventas-margen?from=${FROM}&to=${to}`);
    await expect(page.getByRole('heading', { name: 'Ventas y margen' })).toBeVisible();

    await expect(page.getByTestId('pestanas-linea').getByRole('tab')).toHaveText([
      'Todas',
      'Drywall',
      'Coberturas Aluzinc',
      'Coberturas (UPVC)',
      'Servicios',
      'Reventa',
    ]);
    await expect(tab(page, 'Todas')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('link', { name: 'Descargar Excel' })).toHaveCount(1);

    await tab(page, 'Drywall').click();
    await expect(page).toHaveURL(`/reportes/ventas-margen?from=${FROM}&to=${to}&linea=drywall`);
    await expect(tab(page, 'Drywall')).toHaveAttribute('aria-selected', 'true');
    // D-396: el Excel es el de «Todas» y solo se ofrece ahí.
    await expect(page.getByRole('link', { name: 'Descargar Excel' })).toHaveCount(0);

    await tab(page, 'Servicios').click();
    await expect(page).toHaveURL(/linea=services/);
    // D-392: Servicios declara que no tiene costo, sin margen.
    await expect(page.getByText('Sin costo registrado')).toBeVisible();
    await expect(page.getByText('Margen %')).toHaveCount(0);

    await page.reload();
    await expect(tab(page, 'Servicios')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(`/reportes/ventas-margen?from=${FROM}&to=${to}&linea=services`);

    await page.goBack();
    await expect(tab(page, 'Drywall')).toHaveAttribute('aria-selected', 'true');
    await page.goBack();
    await expect(tab(page, 'Todas')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(`/reportes/ventas-margen?from=${FROM}&to=${to}`);
  });

  test('una línea inválida o sin reporte cae a «Todas» y corrige la URL', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/reportes/ventas-margen?from=${FROM}&linea=acero`);
    await expect(page).toHaveURL(`/reportes/ventas-margen?from=${FROM}`);
    await expect(tab(page, 'Todas')).toHaveAttribute('aria-selected', 'true');

    // D-394: Servicios no tiene inventario valorizado: ni pestaña ni URL.
    await page.goto('/reportes/inventario-valorizado?linea=services');
    await expect(page).toHaveURL('/reportes/inventario-valorizado');
    await expect(page.getByTestId('pestanas-linea').getByRole('tab')).toHaveText([
      'Todas',
      'Drywall',
      'Coberturas Aluzinc',
      'Coberturas (UPVC)',
      'Reventa',
    ]);

    await tab(page, 'Coberturas (UPVC)').click();
    await expect(page).toHaveURL('/reportes/inventario-valorizado?linea=roofing');
    await expect(page.getByRole('heading', { name: 'Bobinas con saldo' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Productos con stock' })).toBeVisible();
    await tab(page, 'Drywall').click();
    await expect(page.getByRole('heading', { name: 'Bobinas con saldo' })).toBeVisible();
  });

  test('la API valida la línea y las pestañas suman «Todas»', async ({ baseURL }) => {
    const api = await adminApi(baseURL!);
    const range = `from=${FROM}&to=${businessToday()}`;

    const bad = await api.get(`/api/reports/sales-margin?${range}&businessLine=acero`);
    expect(bad.status()).toBe(400);
    const noInventory = await api.get('/api/reports/inventory-valuation?businessLine=services');
    expect(noInventory.status()).toBe(400);

    const all = await getJson<SalesMarginDto>(api, `/api/reports/sales-margin?${range}`);
    const tabs = await Promise.all(
      SALES_MARGIN_LINES.map((line) =>
        getJson<SalesMarginDto>(api, `/api/reports/sales-margin?${range}&businessLine=${line}`),
      ),
    );
    const noLine = all.totalsByLine.find((t) => t.businessLine === null)?.salesPen ?? '0';
    expect(sum([...tabs.map((t) => t.totals.salesPen), noLine]).toFixed(4)).toBe(
      all.totals.salesPen,
    );
    expect(sum(tabs.map((t) => t.totals.costPen)).toFixed(4)).toBe(all.totals.costPen);

    const inventory = await getJson<InventoryValuationDto>(api, '/api/reports/inventory-valuation');
    const byLine = await Promise.all(
      INVENTORY_VALUATION_LINES.map((line) =>
        getJson<InventoryValuationDto>(
          api,
          `/api/reports/inventory-valuation?businessLine=${line}`,
        ),
      ),
    );
    // Cantidad × costo tiene 7 decimales: a lo sumo 0,0001 por línea de redondeo (cc23).
    const gap = sum(byLine.map((t) => t.totals.totalValuePen))
      .minus(toDecimal(inventory.totals.totalValuePen))
      .abs();
    expect(gap.lte(toDecimal('0.0001').times(INVENTORY_VALUATION_LINES.length))).toBe(true);
    expect(sum(byLine.map((t) => t.totals.coilQtyKg)).toFixed(3)).toBe(inventory.totals.coilQtyKg);
  });
});
