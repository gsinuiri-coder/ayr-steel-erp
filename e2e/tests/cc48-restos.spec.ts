import { expect, test } from '@playwright/test';
import { loginAsAdmin } from '../helpers/report-fixtures';
import { moreOption } from '../helpers/ui';

/**
 * cc48 — corte A, restos de cc47 y cc47b.
 *
 * - D-630: Cobranzas «Por cliente» con buscar en el API; su Excel lleva el buscar.
 * - D-631: el PDF del Reporte mensual de bobinas lleva el buscar, como su Excel.
 * - D-629: «Totales por línea» en una franja compacta que se pliega sola si la tabla queda baja,
 *   y se abre con un clic.
 *
 * Solo lee: nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Suite local y CI: nunca contra producción (D-126).');

test.describe('Restos de cc47 y cc47b (cc48, corte A)', () => {
  test('Cobranzas «Por cliente»: el buscar va al API, queda en la URL y viaja al Excel', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto('/cobranzas');
    const box = page.getByRole('searchbox', { name: 'Buscar clientes con saldo' });
    await expect(box).toBeVisible({ timeout: 60_000 });
    const request = page.waitForRequest(
      (r) => r.url().includes('/api/invoicing/receivables?') && r.url().includes('search=zzz-cc48'),
    );
    await box.fill('zzz-cc48');
    await request;
    await expect(page).toHaveURL(/rSearch=zzz-cc48/);
    await expect(page.getByText('Ningún cliente con saldo coincide con la búsqueda')).toBeVisible();
    await expect(await moreOption(page, 'Descargar Excel · Por cliente')).toHaveAttribute(
      'href',
      '/api/invoicing/receivables/xlsx?search=zzz-cc48',
    );
    await page.keyboard.press('Escape');

    // Refrescar conserva el buscar.
    await page.reload();
    await expect(box).toHaveValue('zzz-cc48');
  });

  test('Reporte mensual de bobinas: el PDF lleva el buscar, igual que el Excel', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto('/reportes/bobinas');
    const box = page.getByRole('searchbox').first();
    await expect(box).toBeVisible({ timeout: 60_000 });
    await box.fill('galv');
    await expect(page).toHaveURL(/search=galv/);
    await expect(await moreOption(page, 'Descargar PDF')).toHaveAttribute(
      'href',
      /^\/api\/reports\/coils\/pdf\?month=\d{4}-\d{2}.*&search=galv$/,
    );
    await page.keyboard.press('Escape');
    await expect(await moreOption(page, 'Descargar Excel')).toHaveAttribute(
      'href',
      /^\/api\/reports\/coils\/xlsx\?month=\d{4}-\d{2}.*&search=galv$/,
    );
  });

  test('«Totales por línea»: se pliega sola con la ventana baja, se abre con un clic', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    // Una ventana baja: la tabla no llega a 360 px con la franja abierta.
    await page.setViewportSize({ width: 1366, height: 560 });
    await page.goto('/reportes/ventas-margen');
    const strip = page.getByTestId('totales-por-linea');
    await expect(strip).toBeVisible({ timeout: 60_000 });
    await expect(strip).toHaveAttribute('data-collapsed', 'true');
    const toggle = strip.getByRole('button', { name: 'Totales por línea' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(strip.getByRole('list')).toBeHidden();

    // Un clic la abre y manda sobre la decisión automática.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(strip.getByRole('list')).toBeVisible();
    await page.setViewportSize({ width: 1366, height: 540 });
    await expect(strip).toHaveAttribute('data-collapsed', 'false');

    // Con la ventana alta, abierta sola.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.reload();
    await expect(strip).toBeVisible({ timeout: 60_000 });
    await expect(strip).toHaveAttribute('data-collapsed', 'false');
  });
});
