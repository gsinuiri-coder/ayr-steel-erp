import { expect, test } from '@playwright/test';
import { loginAsAdmin } from '../helpers/report-fixtures';
import { moreOption, openFilters } from '../helpers/ui';

/**
 * cc47b — correcciones del UAT de cc47.
 *
 * - D-623: las descargas viven en «Más opciones» de la cabecera; la línea del buscar solo tiene
 *   buscar, «Filtros» y «Ver por». Siguen llevando el buscar y los filtros activos.
 * - D-625: ninguna página tiene scroll horizontal propio a 1366 ni a 1920; una tabla ancha se
 *   desplaza dentro de su contenedor.
 *
 * Solo lee: nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Suite local y CI: nunca contra producción (D-126).');

const PAGES = [
  '/',
  '/cotizaciones',
  '/pedidos',
  '/despachos',
  '/comprobantes',
  '/cobranzas',
  '/clientes',
  '/compras',
  '/bobinas',
  '/flejes',
  '/corte',
  '/inventario',
  '/kardex',
  '/planta',
  '/catalogo',
  '/reportes/ventas-margen',
  '/reportes/ventas-material',
  '/reportes/cuentas-por-cobrar',
  '/reportes/inventario-valorizado',
  '/reportes/bobinas',
  '/reportes/merma',
  '/reportes/produccion',
  '/auditoria',
];

test.describe('Cabecera y ancho (cc47b)', () => {
  for (const [width, height] of [
    [1366, 768],
    [1920, 1080],
  ] as const) {
    test(`D-625: ninguna página desplaza en horizontal a ${String(width)}`, async ({ page }) => {
      // Muchas pantallas seguidas: en modo desarrollo cada una se compila al entrar.
      test.setTimeout(300_000);
      await page.setViewportSize({ width, height });
      await loginAsAdmin(page);
      const wide: string[] = [];
      for (const path of PAGES) {
        await page.goto(path);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        const { sw, cw } = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
        }));
        if (sw > cw) wide.push(`${path} (${String(sw)} > ${String(cw)})`);
      }
      expect(wide).toEqual([]);
    });
  }

  test('D-623: las descargas están en «Más opciones» y llevan el filtro activo', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto('/bobinas?tab=todas');
    await expect(page.getByTestId('linea-tabla')).toBeVisible({ timeout: 60_000 });
    // En la línea no hay descargas.
    await expect(
      page.getByTestId('linea-tabla').getByRole('link', { name: /Descargar/ }),
    ).toHaveCount(0);

    // Con un filtro activo (la línea), el PDF del menú lo lleva y se descarga.
    const modal = await openFilters(page);
    await modal.getByLabel('Línea de negocio').click();
    await page.getByRole('option', { name: 'Drywall', exact: true }).click();
    await modal.getByRole('button', { name: 'Aplicar' }).click();
    await expect(page).toHaveURL(/line=drywall/);
    const pdf = await moreOption(page, 'Descargar PDF');
    await expect(pdf).toHaveAttribute('href', /businessLine=drywall/);
    const [pdfDownload] = await Promise.all([page.waitForEvent('download'), pdf.click()]);
    expect(pdfDownload.suggestedFilename()).toMatch(/\.pdf$/);

    // Lo mismo con un Excel: comprobantes con un filtro de tipo.
    await page.goto('/comprobantes?docType=FACTURA');
    const excel = await moreOption(page, 'Descargar Excel');
    await expect(excel).toHaveAttribute('href', /docType=FACTURA/);
    const [xlsx] = await Promise.all([page.waitForEvent('download'), excel.click()]);
    expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/);

    // La principal nunca es una descarga: en un reporte sin otra acción no hay botón principal.
    await page.goto('/reportes/merma');
    await expect(
      page.locator('[data-slot="header-actions"]').getByRole('link', { name: /Descargar/ }),
    ).toHaveCount(0);
    await expect(await moreOption(page, 'Descargar Excel')).toBeVisible();
  });
});
