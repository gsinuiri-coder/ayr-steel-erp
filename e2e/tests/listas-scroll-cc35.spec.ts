import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials } from '../helpers/api';
import { createCustomer } from '../helpers/sales';

/**
 * cc35 (ESPEC §5): una lista larga tiene **una sola barra**. La página no se desplaza; el título,
 * los filtros, el pie de la tabla y la paginación quedan a la vista, y solo se desplazan las filas
 * (con la cabecera fija arriba).
 *
 * Crea clientes: nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos: nunca contra producción (D-126).');
test.describe.configure({ timeout: 180_000 });

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test('una lista larga tiene una sola barra y el pie queda visible', async ({ page, baseURL }) => {
  const api = await adminApi(baseURL!);
  // Filas de sobra para pasar el alto de la ventana, aunque la base esté recién creada.
  for (let i = 0; i < 30; i++) await createCustomer(api);
  await api.dispose();

  await page.setViewportSize({ width: 1366, height: 640 });
  await loginAsAdmin(page);
  await page.goto('/clientes');
  const container = page.locator('[data-slot="table-container"]').first();
  await expect(container.locator('tbody tr').nth(20)).toBeAttached({ timeout: 60_000 });

  // Una sola barra: la página no se desplaza y la tabla sí.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const doc = document.scrollingElement ?? document.documentElement;
        return doc.scrollHeight - window.innerHeight;
      }),
    )
    .toBeLessThanOrEqual(1);
  expect(await container.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);

  // El pie de la tabla y la paginación quedan dentro de la ventana.
  const viewport = page.viewportSize()!;
  const footer = container.locator('tfoot');
  const pager = page.getByText(/^Mostrando \d+–\d+ de \d+$/);
  for (const el of [footer, pager]) {
    const box = await el.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  }

  // Al bajar hasta el final de las filas, la cabecera sigue arriba y el título no se movió.
  const title = page.getByRole('heading', { level: 1 });
  const titleBefore = (await title.boundingBox())!.y;
  await container.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const head = await container.locator('thead').boundingBox();
  const box = await container.boundingBox();
  expect(Math.abs(head!.y - box!.y)).toBeLessThanOrEqual(2);
  expect((await title.boundingBox())!.y).toBe(titleBefore);
});
