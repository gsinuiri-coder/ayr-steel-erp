import { expect, test } from '@playwright/test';
import { loginAsAdmin } from '../helpers/report-fixtures';
import { applyPeriodPreset, openFilters } from '../helpers/ui';

/**
 * cc47 — Correcciones 07: estándar de tablas (corte A, la muestra).
 *
 * - D-613: las listas ya no llevan el pie gris «N de M … · la suma es de esta página».
 * - D-614: «Bobinas» solo en las pestañas de inventario de las líneas que manejan bobinas.
 * - D-615: la línea estándar (buscar, «Filtros» con su modal, y a la derecha lo que no es filtro).
 * - D-616: Ventas y margen con la estructura única de reportes.
 * - D-617: Cobranzas con una tabla por pestaña, la pestaña en la URL.
 *
 * Solo lee: nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Suite local y CI: nunca contra producción (D-126).');

test.describe('Estándar de tablas (cc47, corte A)', () => {
  test('Cobranzas: una tabla por pestaña, buscar y «Filtros» en la URL, y el Excel los lleva', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto('/cobranzas');
    const tabs = page.getByTestId('pestanas-cobranzas');
    await expect(tabs.getByRole('tab', { name: 'Por cliente' })).toHaveAttribute(
      'data-state',
      'active',
      { timeout: 60_000 },
    );
    // «Por cliente» no se busca ni se filtra en el API: sin buscar ni «Filtros», solo su Excel.
    await expect(page.getByTestId('boton-filtros')).toHaveCount(0);
    await expect(page.locator('a[href="/api/invoicing/receivables/xlsx"]')).toBeAttached();

    // La otra pestaña entra al historial y queda en la URL.
    await tabs.getByRole('tab', { name: 'Comprobantes con saldo' }).click();
    await expect(page).toHaveURL(/\/cobranzas\?tab=pendientes$/);
    await expect(page.getByRole('columnheader', { name: 'Vencimiento' })).toBeVisible();

    // Buscar, primero a la izquierda.
    await page.getByRole('searchbox', { name: 'Buscar comprobantes con saldo' }).fill('F001');
    await expect(page).toHaveURL(/search=F001/);

    // El modal: foco adentro al abrir, Esc lo cierra sin aplicar nada.
    let modal = await openFilters(page);
    await expect(modal).toContainText('Filtros');
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null))
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(page).not.toHaveURL(/docType=/);

    // Elegir y aplicar: el botón dice cuántos hay y la URL los guarda.
    modal = await openFilters(page);
    await modal.getByLabel('Tipo').click();
    await page.getByRole('option', { name: 'Factura', exact: true }).click();
    await modal.getByRole('button', { name: 'Aplicar' }).click();
    await expect(modal).toBeHidden();
    await expect(page).toHaveURL(/docType=FACTURA/);
    await expect(page.getByRole('button', { name: 'Filtros, 1 activo' })).toBeVisible();
    const excel = page.getByRole('link', { name: 'Excel de pendientes' });
    await expect(excel).toHaveAttribute('href', /docType=FACTURA/);
    await expect(excel).toHaveAttribute('href', /search=F001/);

    // Refrescar vuelve al mismo estado.
    await page.reload();
    await expect(tabs.getByRole('tab', { name: 'Comprobantes con saldo' })).toHaveAttribute(
      'data-state',
      'active',
      { timeout: 60_000 },
    );
    await expect(page.getByRole('button', { name: 'Filtros, 1 activo' })).toBeVisible();
    await expect(
      page.getByRole('searchbox', { name: 'Buscar comprobantes con saldo' }),
    ).toHaveValue('F001');

    // «Limpiar» quita los filtros (el buscar queda).
    modal = await openFilters(page);
    await modal.getByRole('button', { name: 'Limpiar' }).click();
    await expect(modal).toBeHidden();
    await expect(page).not.toHaveURL(/docType=/);
    await expect(page.getByRole('button', { name: 'Filtros', exact: true })).toBeVisible();

    // Retroceder vuelve a la pestaña anterior.
    await page.goBack();
    await expect(tabs.getByRole('tab', { name: 'Por cliente' })).toHaveAttribute(
      'data-state',
      'active',
    );
  });

  test('Ventas y margen: el periodo vive en «Filtros», «Ver por» y el Excel a la derecha', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto('/reportes/ventas-margen?from=2026-10-01&to=2026-10-07');
    const toolbar = page.getByTestId('linea-tabla');
    await expect(toolbar.getByRole('searchbox', { name: 'Buscar en el reporte' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(toolbar.getByRole('group', { name: 'Ver por' })).toBeVisible();
    await expect(toolbar.getByRole('link', { name: 'Descargar Excel' })).toBeVisible();
    // Fuera del modal no queda ningún filtro suelto: ni atajos ni fechas.
    await expect(page.getByRole('group', { name: 'Periodo' })).toHaveCount(0);
    // Un periodo distinto de «Este mes» cuenta como filtro activo.
    await expect(page.getByRole('button', { name: 'Filtros, 1 activo' })).toBeVisible();
    await expect(page.getByTestId('periodo-rango')).toHaveText('Del 01/10/2026 al 07/10/2026');

    // Un rango al revés no se aplica: el modal lo dice y la URL no cambia.
    const modal = await openFilters(page);
    await modal.getByLabel('Desde').fill('2026-10-10');
    await modal.getByRole('button', { name: 'Aplicar' }).click();
    await expect(modal.getByRole('alert')).toContainText('El periodo no es válido');
    await expect(page).toHaveURL(/from=2026-10-01&to=2026-10-07/);
    await page.keyboard.press('Escape');

    // «Este mes» desde el modal: la URL, el rango y el Excel siguen el periodo.
    await applyPeriodPreset(page, 'Este mes');
    await expect(page.getByRole('button', { name: 'Filtros', exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/from=2026-10-01&to=2026-10-07/);
    await expect(toolbar.getByRole('link', { name: 'Descargar Excel' })).not.toHaveAttribute(
      'href',
      /to=2026-10-07/,
    );
  });

  test('D-614: «Bobinas por tipo» solo en las líneas con bobinas; D-613: sin pie gris', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto('/inventario');
    await expect(page.getByText('Bobinas por tipo')).toBeVisible({ timeout: 60_000 });
    for (const line of ['Coberturas (UPVC)', 'Reventa']) {
      await page.getByRole('tab', { name: line }).click();
      await expect(page.getByText('Productos de catálogo')).toBeVisible();
      await expect(page.getByText('Bobinas por tipo')).toHaveCount(0);
    }

    for (const path of ['/pedidos', '/cotizaciones', '/comprobantes', '/clientes']) {
      await page.goto(path);
      await expect(page.locator('main table thead')).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('main table tfoot')).toHaveCount(0);
      await expect(page.getByText(/la suma es de esta página/)).toHaveCount(0);
    }
  });
});
