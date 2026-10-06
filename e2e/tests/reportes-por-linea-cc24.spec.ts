import { expect, test, type Page } from '@playwright/test';
import {
  SALES_BY_MATERIAL_LINES,
  businessToday,
  sum,
  toDecimal,
  type SalesByMaterialDto,
  type SalesMarginDto,
} from '@ayr/shared';
import { adminApi, adminCredentials, getJson } from '../helpers/api';

/**
 * cc24 (D-406..D-409, D-413) — «Ventas por material» por línea y el margen de «Todas» sin
 * Servicios.
 *
 * - Ventas por material: Coberturas Aluzinc y Drywall, sin «Todas», Aluzinc por defecto; la
 *   pestaña en `?linea=` con historial, refrescar y URL inválida (D-394, D-395); el Excel solo
 *   en Coberturas Aluzinc (D-396, criterio de D-399).
 * - Para el mismo rango, la venta por material de una línea es la venta de esa línea en ventas
 *   y margen, contando los pedidos que allá quedan fuera de los totales (D-406).
 * - En «Todas» de ventas y margen, el margen se calcula sin Servicios (D-409).
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

test.describe('Reportes por línea (cc24)', () => {
  test('ventas por material: pestañas, historial, refrescar y URL inválida', async ({ page }) => {
    const to = businessToday();
    await loginAsAdmin(page);
    await page.goto(`/reportes/ventas-material?from=${FROM}&to=${to}`);
    await expect(page.getByRole('heading', { name: 'Ventas por material' })).toBeVisible();

    await expect(page.getByTestId('pestanas-linea').getByRole('tab')).toHaveText([
      'Coberturas Aluzinc',
      'Drywall',
      'Coberturas (UPVC)',
      'Reventa',
    ]);
    await expect(tab(page, 'Coberturas Aluzinc')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('link', { name: 'Descargar Excel' })).toHaveCount(1);

    await tab(page, 'Drywall').click();
    await expect(page).toHaveURL(`/reportes/ventas-material?from=${FROM}&to=${to}&linea=drywall`);
    await expect(tab(page, 'Drywall')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('link', { name: 'Descargar Excel' })).toHaveCount(0);
    await expect(page.getByTestId('cuadre-ventas-margen')).toContainText('venta de Drywall');

    await page.reload();
    await expect(tab(page, 'Drywall')).toHaveAttribute('aria-selected', 'true');

    // D-417: por producto, sin filtros de tipo, espesor ni color.
    await tab(page, 'Reventa').click();
    await expect(page).toHaveURL(`/reportes/ventas-material?from=${FROM}&to=${to}&linea=trading`);
    await expect(page.getByTestId('ventas-producto')).toBeVisible();
    await expect(page.getByText('Espesor', { exact: true })).toHaveCount(0);
    await page.goBack();
    await expect(tab(page, 'Drywall')).toHaveAttribute('aria-selected', 'true');

    await page.goBack();
    await expect(tab(page, 'Coberturas Aluzinc')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(`/reportes/ventas-material?from=${FROM}&to=${to}`);

    // D-394: Servicios no tiene este reporte, «todas» no existe acá y la de defecto no se escribe.
    for (const bad of ['services', 'todas', 'metallic-roofing']) {
      await page.goto(`/reportes/ventas-material?from=${FROM}&linea=${bad}`);
      await expect(page).toHaveURL(`/reportes/ventas-material?from=${FROM}`);
      await expect(tab(page, 'Coberturas Aluzinc')).toHaveAttribute('aria-selected', 'true');
    }
  });

  test('bobinas: Aluzinc por defecto, el mes y la pestaña en la URL, descargas por línea', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto('/reportes/bobinas?mes=2026-09');
    await expect(page.getByRole('heading', { name: 'Reporte mensual de bobinas' })).toBeVisible();
    await expect(page.getByTestId('pestanas-linea').getByRole('tab')).toHaveText([
      'Coberturas Aluzinc',
      'Drywall',
    ]);
    await expect(tab(page, 'Coberturas Aluzinc')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('link', { name: 'Descargar Excel' })).toHaveAttribute(
      'href',
      '/api/reports/coils/xlsx?month=2026-09&businessLine=metallic-roofing',
    );

    await tab(page, 'Drywall').click();
    await expect(page).toHaveURL('/reportes/bobinas?mes=2026-09&linea=drywall');
    await page.reload();
    await expect(tab(page, 'Drywall')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#reporte-mes')).toHaveValue('2026-09');

    await page.goBack();
    await expect(tab(page, 'Coberturas Aluzinc')).toHaveAttribute('aria-selected', 'true');

    await page.goto('/reportes/bobinas?linea=services');
    await expect(page).toHaveURL('/reportes/bobinas');
    await expect(tab(page, 'Coberturas Aluzinc')).toHaveAttribute('aria-selected', 'true');
  });

  test('la venta por material de cada línea es la de ventas y margen', async ({ baseURL }) => {
    const api = await adminApi(baseURL!);
    const range = `from=${FROM}&to=${businessToday()}`;

    const bad = await api.get(`/api/reports/sales-by-material?${range}&businessLine=services`);
    expect(bad.status()).toBe(400);

    for (const line of SALES_BY_MATERIAL_LINES) {
      const material = await getJson<SalesByMaterialDto>(
        api,
        `/api/reports/sales-by-material?${range}&businessLine=${line}`,
      );
      const margin = await getJson<SalesMarginDto>(
        api,
        `/api/reports/sales-margin?${range}&businessLine=${line}`,
      );
      expect(material.businessLine).toBe(line);
      // Allá, la pestaña de la línea más lo que deja fuera de sus totales.
      const marginLine = sum([
        margin.totals.salesPen,
        margin.totals.excludedSalesPen,
        margin.totals.untraceableSalesPen,
      ]).toFixed(4);
      expect(material.reconciliation.lineSalesPen).toBe(marginLine);
      // Y la venta de la línea es la de sus filas, su no trazable y lo que no entra a las filas.
      const products = material.products;
      const parts =
        products === null
          ? sum([
              ...material.rows.filter((r) => r.kind !== 'BOBINA').map((r) => r.salesPen),
              ...material.untraceable.filter((u) => u.kind !== 'BOBINA').map((u) => u.salesPen),
              material.reconciliation.unclassifiedSalesPen,
            ])
          : // D-417; en Reventa, más las bobinas enteras que viven en otra pestaña (D-413).
            sum([
              ...products.rows.map((r) => r.salesPen),
              ...products.untraceable.map((u) => u.salesPen),
              material.reconciliation.coilSalesPen,
            ]);
      if (products === null) {
        // El motor de D-354 redondea por separado la parte trazada y la no trazable de cada
        // línea prorrateada: a lo sumo 0,0001 por porción no trazable.
        const gap = parts.minus(toDecimal(material.reconciliation.lineSalesPen)).abs();
        expect(gap.lte(toDecimal('0.0001').times(material.untraceable.length))).toBe(true);
      } else {
        expect(parts.toFixed(4)).toBe(material.reconciliation.lineSalesPen);
      }
    }
  });

  test('«Todas» de ventas y margen: el margen sin Servicios ni «Sin línea»', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const range = `from=${FROM}&to=${businessToday()}`;
    const all = await getJson<SalesMarginDto>(api, `/api/reports/sales-margin?${range}`);
    // D-409 y D-419: la venta sin costo registrado es la de Servicios más la «Sin línea».
    const noCost = all.totalsByLine
      .filter((t) => t.businessLine === 'services' || t.businessLine === null)
      .map((t) => t.salesPen);
    expect(all.totals.noCostSalesPen).toBe(sum(noCost).toFixed(4));
    expect(all.totals.marginPen).toBe(
      toDecimal(all.totals.salesPen)
        .minus(all.totals.noCostSalesPen)
        .minus(all.totals.costPen)
        .toFixed(4),
    );
  });
});
