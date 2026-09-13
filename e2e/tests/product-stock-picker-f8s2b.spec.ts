import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, postJson } from '../helpers/api';
import {
  metersOf,
  pieces,
  purgeRoofingTrail,
  ROOFING_LINE,
  setupRoofingScenario,
  type RoofingScenario,
} from '../helpers/roofing';
import { createCustomer, createQuotation } from '../helpers/sales';
import { chooseOption, chooseProductWithStock } from '../helpers/ui';

/**
 * F8-S2b/M1 — el picker de producto con stock (D-188).
 *
 * Reemplaza al `<select>` de SKU sueltos: elegir un producto pasa por ver, en el mismo
 * modal, el agregado de materia prima del pool (espesor + color, con sus metros lineales
 * teóricos) y el disponible del SKU — la misma cuenta que ya usa la fila y que confirmar
 * vuelve a comprobar bajo lock. **Elegir sin stock no está bloqueado**: el aviso vive en la
 * fila, no en el picker.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 120_000 });

function trailOf(s: RoofingScenario) {
  return {
    supplierId: s.supplier.id,
    finishId: s.finish.id,
    colorId: s.color.id,
    productIds: [s.product.id],
    coilIds: [s.coil.id],
    purchaseIds: [s.purchaseId],
    orderIds: [] as string[],
    quotationIds: [] as string[],
  };
}

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

test.describe('F8-S2b/M1 — picker de producto con stock', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('D-188: el pool de bobinas y el disponible del SKU se ven antes de elegir, y elegir sin stock no bloquea', async ({
    page,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '80.8' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      // Un pedido firme se lleva **todo** el agregado: 20 m × 4.04 kg/m = 80.800 kg, los mismos
      // 80.8 kg físicos del escenario. Disponible después: 0.000.
      const rivalRows = pieces([20, 1]);
      const rival = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rivalRows),
        unitPricePen: '60',
        pieces: rivalRows,
      });
      trail.quotationIds.push(rival.id);
      const order = await postJson<{ id: string }>(
        api,
        `/api/sales/quotations/${rival.id}/confirm`,
      );
      trail.orderIds.push(order.id);

      await loginAsAdmin(page);
      await page.goto('/cotizaciones/nueva');
      await chooseOption(
        page,
        page.getByLabel('Cliente', { exact: true }),
        `${customer.name} — ${customer.docNumber}`,
      );
      // La cotización nueva ya nace con una línea vacía: no hace falta "Agregar línea" para
      // la primera.
      await page.getByLabel('Línea de negocio de la línea 1').click();
      await page.getByRole('option', { name: 'Coberturas Aluzinc' }).click();

      await page.getByLabel('Producto de la línea 1').click();
      const dialog = page.getByRole('dialog');
      const pool = dialog.getByText('Bobinas del pool (espesor + color)').locator('xpath=..');
      await expect(pool).toBeVisible();
      // El grupo del pool de ESTE escenario: en la suite completa pueden convivir bobinas
      // abiertas de otros tests en la misma línea de negocio, así que se ubica el `<li>` por
      // el color (único por test, `E2E Color XXXX`) y se comprueba dentro de ese, no del
      // pool entero — que puede traer más de un grupo con "m lineales".
      const group = pool.locator('li', { hasText: s.color.name });
      await expect(group).toBeVisible();
      await expect(group.getByText(/m lineales/)).toBeVisible();

      // El SKU quedó sin nada disponible — se ve en rojo, y no impide elegirlo.
      await dialog.getByLabel('Filtrar productos').fill(s.product.sku);
      const row = dialog.getByRole('row', { name: new RegExp(s.product.sku) });
      await expect(row.getByText(/0\.000 kg de materia prima/)).toBeVisible({ timeout: 15_000 });
      await dialog.getByRole('button', { name: `Elegir ${s.product.sku}`, exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByLabel('Producto de la línea 1')).toContainText(s.product.sku);

      // La línea también avisa, y sigue sin bloquear: se cotiza igual.
      await page.getByLabel('Planchas del largo 1 de la línea 1').fill('1');
      await page.getByLabel('Largo 1 de la línea 1 en metros').fill('5');
      await expect(page.getByText(/no alcanza/)).toBeVisible();
      await page.getByLabel('Precio unitario de la línea 1').fill('60');

      const created = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().includes('/api/sales/quotations'),
      );
      await page.getByRole('button', { name: 'Crear cotización' }).click();
      const response = await created;
      expect(response.status(), await response.text()).toBe(201);
      const body = (await response.json()) as { id: string };
      trail.quotationIds.push(body.id);
      await expect(page).toHaveURL(new RegExp(`/cotizaciones/${body.id}$`));
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
