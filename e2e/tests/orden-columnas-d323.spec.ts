import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson } from '../helpers/api';
import { deactivateTrail } from '../helpers/production';
import {
  createCustomer,
  createQuotationWithLines,
  createSellableProduct,
  purgeSalesTrail,
} from '../helpers/sales';

/**
 * D-323 (correcciones 04, M1): el orden por columna de un listado paginado es **del servidor** —
 * ordena la lista entera, no la página que se ve— y los filtros por columna de D-295 ya no
 * existen: cada encabezado reordena.
 *
 * Crea clientes y cotizaciones: nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea clientes y cotizaciones: nunca contra producción (D-126).');
test.describe.configure({ timeout: 180_000 });

const SERVICES_LINE = 'services';

async function customerNamed(api: APIRequestContext, name: string): Promise<{ id: string }> {
  const base = await createCustomer(api);
  // Un cliente con el nombre que el test necesita: el orden por cliente se prueba con dos
  // nombres que se distinguen en la primera letra, para no depender de la colación de Postgres.
  const res = await api.patch(`/api/customers/${base.id}`, { data: { name } });
  expect(res.ok(), await res.text()).toBe(true);
  return { id: base.id };
}

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test.describe('D-323 — orden por columna en el servidor', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('cotizaciones: el orden es de la lista entera (entre páginas), el filtro por columna no existe y una clave inventada es 400', async ({
    page,
  }) => {
    const token = `ORD${randomBytes(3).toString('hex').toUpperCase()}`;
    const service = await createSellableProduct(api, {
      lineCode: SERVICES_LINE,
      listPricePen: '100.0000',
    });
    const alfa = await customerNamed(api, `Alfa ${token}`);
    const zeta = await customerNamed(api, `Zeta ${token}`);
    const trail: { quotationIds: string[] } = { quotationIds: [] };
    try {
      // Zeta se cotiza primero: el orden por defecto (número descendente) deja a Alfa arriba y el
      // ascendente por cliente también; el descendente por cliente los invierte.
      for (const customer of [zeta, alfa]) {
        const q = await createQuotationWithLines(api, {
          customerId: customer.id,
          businessLine: SERVICES_LINE,
          items: [{ productId: service.id, qty: '1', unitPricePen: '100.0000' }],
        });
        trail.quotationIds.push(q.id);
      }

      const names = async (dir: 'asc' | 'desc', pageSize = 1, pageNo = 1) => {
        const list = await getJson<{ items: { customerName: string }[]; total: number }>(
          api,
          `/api/sales/quotations?search=${token}&sort=customer&dir=${dir}&page=${String(pageNo)}&pageSize=${String(pageSize)}`,
        );
        return list.items.map((i) => i.customerName);
      };
      // Con páginas de una fila, la primera página ya dice cuál es la mayor/menor de **toda** la
      // lista: si solo ordenara la página, siempre saldría la misma fila.
      expect(await names('asc')).toEqual([`Alfa ${token}`]);
      expect(await names('desc')).toEqual([`Zeta ${token}`]);
      expect(await names('asc', 1, 2)).toEqual([`Zeta ${token}`]);

      const bad = await api.get('/api/sales/quotations?sort=inventada');
      expect(bad.status()).toBe(400);

      // En pantalla: el encabezado ordena, deja el orden en la URL y no hay filtros de columna.
      await loginAsAdmin(page);
      await page.goto(`/cotizaciones?search=${token}`);
      const rows = page.locator('tbody tr');
      await expect(rows).toHaveCount(2, { timeout: 60_000 });
      await expect(page.getByLabel(/^Filtrar por /)).toHaveCount(0);

      await page.getByRole('button', { name: 'Cliente', exact: true }).click();
      await expect(page).toHaveURL(/sort=customer/);
      await expect(rows.first()).toContainText(`Alfa ${token}`);
      await expect(page.getByRole('columnheader', { name: 'Cliente' })).toHaveAttribute(
        'aria-sort',
        'ascending',
      );
      await page.getByRole('button', { name: 'Cliente', exact: true }).click();
      await expect(page).toHaveURL(/dir=desc/);
      await expect(rows.first()).toContainText(`Zeta ${token}`);

      // Recargar conserva el orden.
      await page.reload();
      await expect(rows.first()).toContainText(`Zeta ${token}`, { timeout: 30_000 });
    } finally {
      await purgeSalesTrail(api, trail);
      await deactivateTrail(api, { productIds: [service.id] });
    }
  });

  test('catálogo: los encabezados ordenan y ya no hay cuadros «Filtrar…»', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/catalogo');
    await expect(page.getByRole('tab').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel(/^Filtrar por /)).toHaveCount(0);
    const sku = page.getByRole('button', { name: 'SKU', exact: true });
    await expect(sku).toBeVisible();
    await sku.click();
    await expect(page).toHaveURL(/sort=sku/);
    await expect(page.getByRole('columnheader', { name: 'SKU' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });
});
