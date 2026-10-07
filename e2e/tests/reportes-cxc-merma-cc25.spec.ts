import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  COIL_REPORT_LINES,
  businessToday,
  sum,
  toDecimal,
  type CoilWasteDto,
  type InventoryMovementDto,
  type PaginatedResult,
  type ReceivableTotalsDto,
  type ReceivablesAgingDto,
} from '@ayr/shared';
import { adminApi, adminCredentials, getJson } from '../helpers/api';

/**
 * cc25 (D-421..D-426) — reportes de cuentas por cobrar y de merma.
 *
 * - CxC: el total y la cantidad de clientes son los de las tarjetas de /cobranzas (la misma
 *   lectura, D-421); con filtro, los vendedores suman el total; el vendedor va en la URL.
 * - Merma: el consumo de cada bobina es la suma de sus salidas de producción vivas en el kardex
 *   del rango; pestañas Aluzinc y Drywall en la URL, sin «Todas» (D-424).
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

/** Los movimientos de kardex de bobinas en el rango (de una bobina o de una línea), por páginas. */
async function coilMovements(
  api: APIRequestContext,
  filter: string,
  from: string,
  to: string,
): Promise<InventoryMovementDto[]> {
  const out: InventoryMovementDto[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const res = await getJson<PaginatedResult<InventoryMovementDto>>(
      api,
      `/api/inventory/movements?itemType=COIL&${filter}&from=${from}&to=${to}&page=${page}&pageSize=200`,
    );
    out.push(...res.items);
    if (out.length >= res.total || res.items.length === 0) break;
  }
  return out;
}

/** El consumo de producción vivo: salidas `PRODUCTION` ni anuladas ni anulación de otra. */
function liveProductionKg(movements: InventoryMovementDto[]): string {
  const production = movements.filter(
    (m) => m.refType === 'PRODUCTION' && m.reversalOfId === null && m.reversedById === null,
  );
  return sum(
    production.map((m) => (m.type === 'IN' ? toDecimal(m.qty).negated() : toDecimal(m.qty))),
  ).toFixed(3);
}

const FROM = '2026-01-01';

test.describe('Reportes de CxC y merma (cc25)', () => {
  test('CxC: el total es el de cobranzas y los vendedores lo suman', async ({ baseURL }) => {
    const api = await adminApi(baseURL!);
    const report = await getJson<ReceivablesAgingDto>(api, '/api/reports/receivables-aging');
    const cobranzas = await getJson<ReceivableTotalsDto>(api, '/api/invoicing/receivables/summary');

    expect(report.totals.balancePen).toBe(cobranzas.totalBalancePen);
    expect(report.totals.customerCount).toBe(cobranzas.customerCount);
    expect(sum(Object.values(report.totals.buckets)).toFixed(4)).toBe(report.totals.balancePen);

    const bySeller = [];
    for (const seller of report.sellers) {
      const one = await getJson<ReceivablesAgingDto>(
        api,
        `/api/reports/receivables-aging?sellerId=${seller.id}`,
      );
      bySeller.push(one.totals.balancePen);
    }
    expect(sum(bySeller).toFixed(4)).toBe(report.totals.balancePen);

    const bad = await api.get('/api/reports/receivables-aging?sellerId=nadie');
    expect(bad.status()).toBe(400);
    const xlsx = await api.get('/api/reports/receivables-aging/xlsx');
    expect(xlsx.status()).toBe(200);
    expect(xlsx.headers()['content-disposition']).toContain('cuentas-por-cobrar-');
  });

  test('CxC: pantalla, menú y vendedor inválido en la URL', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/reportes/cuentas-por-cobrar?vendedor=nadie');
    await expect(page.getByRole('heading', { name: 'Cuentas por cobrar' })).toBeVisible();
    // Un valor que no es un id cae a «todos» y se corrige la URL.
    await expect(page).toHaveURL('/reportes/cuentas-por-cobrar');
    await expect(page.getByRole('combobox', { name: 'Vendedor' })).toHaveText(
      'Todos los vendedores',
    );
    await expect(page.getByRole('link', { name: 'Descargar Excel' })).toHaveAttribute(
      'href',
      '/api/reports/receivables-aging/xlsx',
    );
    await expect(page.getByRole('link', { name: 'Cuentas por cobrar' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Merma por bobina' })).toBeVisible();
  });

  test('merma: el consumo de cada bobina es el de sus salidas de producción del kardex', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const to = businessToday();

    const bad = await api.get(
      `/api/reports/coil-waste?from=${FROM}&to=${to}&businessLine=services`,
    );
    expect(bad.status()).toBe(400);

    for (const line of COIL_REPORT_LINES) {
      const report = await getJson<CoilWasteDto>(
        api,
        `/api/reports/coil-waste?from=${FROM}&to=${to}&businessLine=${line}`,
      );
      expect(report.businessLine).toBe(line);
      // Toda la línea: el consumo del reporte es el de producción del kardex del rango, sin que
      // falte ni sobre una bobina (D-436: la reventa ya no saca ninguna).
      const lineKardex = await coilMovements(api, `businessLine=${line}`, FROM, to);
      expect(report.totals.consumedKg).toBe(liveProductionKg(lineKardex));
      // Y bobina por bobina, las primeras, contra su propio kardex.
      for (const row of report.rows.slice(0, 8)) {
        const movements = await coilMovements(api, `itemId=${row.coilId}`, FROM, to);
        expect(row.consumedKg, row.code).toBe(liveProductionKg(movements));
      }
      expect(sum(report.rows.map((r) => r.consumedKg)).toFixed(3)).toBe(report.totals.consumedKg);
    }
  });

  test('merma: pestañas, historial, refrescar y URL inválida', async ({ page }) => {
    const to = businessToday();
    await loginAsAdmin(page);
    await page.goto(`/reportes/merma?from=${FROM}&to=${to}`);
    await expect(page.getByRole('heading', { name: 'Merma por bobina' })).toBeVisible();
    await expect(page.getByTestId('pestanas-linea').getByRole('tab')).toHaveText([
      'Coberturas Aluzinc',
      'Drywall',
    ]);
    await expect(tab(page, 'Coberturas Aluzinc')).toHaveAttribute('aria-selected', 'true');
    // D-426: sin Excel.
    await expect(page.getByRole('link', { name: 'Descargar Excel' })).toHaveCount(0);

    await tab(page, 'Drywall').click();
    await expect(page).toHaveURL(`/reportes/merma?from=${FROM}&to=${to}&linea=drywall`);
    await page.reload();
    await expect(tab(page, 'Drywall')).toHaveAttribute('aria-selected', 'true');
    // cc32 (corte 2): el periodo único, con el rango escrito al lado.
    await expect(page.getByTestId('periodo-rango')).toContainText('Del 01/01/2026 al ');

    await page.goBack();
    await expect(tab(page, 'Coberturas Aluzinc')).toHaveAttribute('aria-selected', 'true');

    // cc32 (corte 2): el periodo va siempre en la URL; la fecha que falta se completa (hasta hoy).
    for (const bad of ['services', 'todas', 'trading']) {
      await page.goto(`/reportes/merma?from=${FROM}&linea=${bad}`);
      await expect(page).toHaveURL(`/reportes/merma?from=${FROM}&to=${to}`);
      await expect(tab(page, 'Coberturas Aluzinc')).toHaveAttribute('aria-selected', 'true');
    }
  });
});
