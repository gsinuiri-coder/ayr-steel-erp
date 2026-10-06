import { expect, request, test } from '@playwright/test';
import {
  AGING_BUCKETS,
  COIL_REPORT_LINES,
  sum,
  toDecimal,
  type AdminDashboardDto,
  type CoilWasteDto,
  type InventoryValuationDto,
  type ReceivablesAgingDto,
  type SalesMarginDto,
} from '@ayr/shared';
import { adminApi, adminCredentials, createUser, getJson } from '../helpers/api';

/**
 * cc26 (D-440, M4) — el Panel del administrador.
 *
 * Cada cifra del Panel es la de su reporte para el mismo rango: se piden los dos y se comparan
 * campo por campo. El vendedor y planta no reciben el Panel del administrador (lleva costos).
 *
 * Solo lee, pero entra como administrador de la suite: nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Suite local y CI: nunca contra producción (D-126).');

test.describe('Panel del administrador (cc26)', () => {
  test('cada cifra es la de su reporte para el mismo rango', async ({ baseURL }) => {
    const api = await adminApi(baseURL!);
    const panel = await getJson<AdminDashboardDto>(api, '/api/reports/admin-dashboard');
    const range = (r: { from: string; to: string }) => `from=${r.from}&to=${r.to}`;

    const sales = await getJson<SalesMarginDto>(
      api,
      `/api/reports/sales-margin?${range(panel.current)}`,
    );
    expect(panel.sales).toEqual({
      salesPen: sales.totals.salesPen,
      noCostSalesPen: sales.totals.noCostSalesPen,
      costPen: sales.totals.costPen,
      marginPen: sales.totals.marginPen,
      marginPct: sales.totals.marginPct,
      partialOrderCount: sales.totals.partialOrderCount,
      excludedOrderCount: sales.totals.excludedOrderCount,
      excludedSalesPen: sales.totals.excludedSalesPen,
      untraceableOrderCount: sales.totals.untraceableOrderCount,
      untraceableSalesPen: sales.totals.untraceableSalesPen,
    });
    expect(panel.salesByLine.map((l) => [l.businessLine, l.salesPen, l.marginPct])).toEqual(
      sales.totalsByLine.map((l) => [l.businessLine, l.salesPen, l.marginPct]),
    );
    // D-444: lo facturado por día suma la venta del reporte más la de los pedidos fuera.
    const byDay = sum(panel.salesByDay.map((d) => toDecimal(d.salesPen)));
    expect(byDay.toFixed(4)).toBe(
      toDecimal(sales.totals.salesPen)
        .plus(sales.totals.excludedSalesPen)
        .plus(sales.totals.untraceableSalesPen)
        .toFixed(4),
    );

    const previous = await getJson<SalesMarginDto>(
      api,
      `/api/reports/sales-margin?${range(panel.previous)}`,
    );
    expect(panel.previousSalesPen).toBe(previous.totals.salesPen);

    const aging = await getJson<ReceivablesAgingDto>(api, '/api/reports/receivables-aging');
    expect(panel.receivables.balancePen).toBe(aging.totals.balancePen);
    expect(panel.receivables.buckets).toEqual(aging.totals.buckets);
    expect(panel.receivables.overduePen).toBe(
      sum(AGING_BUCKETS.filter((b) => b !== 'CURRENT').map((b) => aging.totals.buckets[b])).toFixed(
        4,
      ),
    );

    const inventory = await getJson<InventoryValuationDto>(api, '/api/reports/inventory-valuation');
    expect(panel.inventory.totalValuePen).toBe(inventory.totals.totalValuePen);
    expect(panel.inventory.coilValuePen).toBe(inventory.totals.coilValuePen);
    expect(panel.inventory.productValuePen).toBe(inventory.totals.productValuePen);

    for (const line of COIL_REPORT_LINES) {
      const waste = await getJson<CoilWasteDto>(
        api,
        `/api/reports/coil-waste?${range(panel.current)}&businessLine=${line}`,
      );
      const flagged = waste.rows.flatMap((r) => r.productions).filter((p) => p.outOfTolerance);
      expect(panel.outOfTolerance.find((l) => l.businessLine === line)?.productionCount).toBe(
        flagged.length,
      );
    }
  });

  test('el vendedor y planta no reciben el Panel del administrador', async ({ baseURL }) => {
    const api = await adminApi(baseURL!);
    for (const role of ['VENDEDOR', 'SUPERVISOR_PLANTA'] as const) {
      const user = await createUser(api, role);
      const other = await request.newContext({ baseURL });
      const login = await other.post('/api/auth/login', {
        data: { email: user.email, password: user.password },
      });
      expect(login.ok()).toBeTruthy();
      expect((await other.get('/api/reports/admin-dashboard')).status()).toBe(403);
      await other.dispose();
    }
  });

  test('la pantalla muestra las cifras y enlaza a cada reporte', async ({ page, baseURL }) => {
    const api = await adminApi(baseURL!);
    const panel = await getJson<AdminDashboardDto>(api, '/api/reports/admin-dashboard');
    const { email, password } = adminCredentials();
    await page.goto('/login');
    await page.getByLabel('Correo electrónico').fill(email);
    await page.getByLabel('Contraseña', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Ingresar' }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });

    const section = page.getByRole('region', { name: 'El mes en cifras' });
    await expect(section).toBeVisible({ timeout: 30_000 });
    await expect(
      section.locator(
        `a[href="/reportes/ventas-margen?from=${panel.current.from}&to=${panel.current.to}"]`,
      ),
    ).not.toHaveCount(0);
    await expect(section.locator('a[href="/reportes/cuentas-por-cobrar"]')).not.toHaveCount(0);
    await expect(section.locator('a[href="/reportes/inventario-valorizado"]')).not.toHaveCount(0);
  });
});
