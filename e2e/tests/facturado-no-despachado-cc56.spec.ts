import { expect, test, type Page } from '@playwright/test';
import type { UndispatchedAtCloseDto } from '@ayr/shared';
import { adminCredentials } from '../helpers/api';

/**
 * cc56 (D-670) — «Facturado y no despachado al cierre» en Ventas y margen y en el inventario
 * valorizado. Las filas salen de un fixture (`page.route`): lo que se prueba es la pantalla; el
 * cálculo lo cubren los unitarios del API. Solo lee: nunca contra producción (D-126).
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

function fixture(from: string, to: string): UndispatchedAtCloseDto {
  return {
    from,
    to,
    rows: [
      {
        documentId: '00000000-0000-4000-8000-000000000561',
        number: 'F999-00000001',
        issueDate: from,
        customerName: 'Cliente E2E cc56',
        salesPen: '1000.0000',
        estimatedCostPen: '700.0000',
        dispatchDates: ['2099-01-05'],
        status: 'DESPACHADO_DESPUES',
      },
    ],
    totals: { count: 1, salesPen: '1000.0000', estimatedCostPen: '700.0000', withoutCostCount: 0 },
  };
}

async function routeFixture(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.route('**/api/reports/undispatched-at-close?*', async (route) => {
    const url = new URL(route.request().url());
    seen.push(`${url.searchParams.get('from') ?? ''}..${url.searchParams.get('to') ?? ''}`);
    await route.fulfill({
      json: fixture(url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? ''),
    });
  });
  return seen;
}

test('Ventas y margen muestra lo facturado y no despachado del periodo, con su Excel', async ({
  page,
}) => {
  await loginAsAdmin(page);
  const seen = await routeFixture(page);
  await page.goto('/reportes/ventas-margen?from=2026-09-01&to=2026-09-30');
  const section = page.getByTestId('facturado-no-despachado');
  await expect(section).toContainText('Facturado y no despachado al cierre');
  await expect(section.getByTestId('fila-facturado-no-despachado')).toContainText('F999-00000001');
  await expect(section).toContainText('Salió después del cierre');
  await expect(section.getByRole('link', { name: 'Descargar Excel' })).toHaveAttribute(
    'href',
    '/api/reports/undispatched-at-close/xlsx?from=2026-09-01&to=2026-09-30',
  );
  expect(seen).toContain('2026-09-01..2026-09-30');
});

test('el inventario valorizado la muestra por mes de cierre', async ({ page }) => {
  await loginAsAdmin(page);
  const seen = await routeFixture(page);
  await page.goto('/reportes/inventario-valorizado');
  await page.getByLabel('Cierre de').fill('2026-08');
  const section = page.getByTestId('facturado-no-despachado');
  await expect(section.getByTestId('fila-facturado-no-despachado')).toHaveCount(1);
  await expect.poll(() => seen).toContain('2026-08-01..2026-08-31');
});
