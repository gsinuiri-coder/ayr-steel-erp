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
 * F8-S2b/M1 — el picker de producto con stock (D-188), simplificado en F8-S3b/M1.
 *
 * Reemplaza al `<select>` de SKU sueltos: elegir un producto pasa por ver, en el mismo
 * modal, el disponible del SKU — la misma cuenta que ya usa la fila y que confirmar vuelve
 * a comprobar bajo lock. Desde F8-S3b el modal no muestra el pool de bobinas (espesor +
 * color) en ninguna línea, y cabe sin scroll horizontal. **Elegir sin stock no está bloqueado**: el aviso vive en la
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

  test('D-188: el disponible del SKU se ve antes de elegir, sin pool ni scroll horizontal, y elegir sin stock no bloquea', async ({
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
        // RF-S3/M1: el campo busca en el servidor contra `name`/`docNumber` por separado.
        customer.docNumber,
      );
      // La cotización nueva ya nace con una línea vacía: no hace falta "Agregar línea" para
      // la primera.
      await page.getByLabel('Línea de negocio de la línea 1').click();
      await page.getByRole('option', { name: 'Coberturas Aluzinc' }).click();

      await page.getByLabel('Producto de la línea 1').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('Filtrar productos')).toBeVisible();
      // F8-S3b/M1: el pool de bobinas salió del modal, también en coberturas.
      await expect(dialog.getByText('Bobinas del pool (espesor + color)')).toHaveCount(0);
      await expect(dialog.getByText(/m lineales/)).toHaveCount(0);

      // El SKU quedó sin nada disponible — se ve en rojo, y no impide elegirlo.
      // F8-S3c/M3: el disponible de materia prima se ve en ML, con el kg entre paréntesis.
      await dialog.getByLabel('Filtrar productos').fill(s.product.sku);
      const row = dialog.getByRole('row', { name: new RegExp(s.product.sku) });
      await expect(row.getByText(/0\.000 m \(0\.000 kg\)/)).toBeVisible({ timeout: 15_000 });

      // Sin scroll horizontal: se mide en el DOM, no en una captura. Ni la tabla ni su
      // contenedor desbordan a lo ancho, y «Elegir» cae entero dentro del diálogo.
      const choose = dialog.getByRole('button', { name: `Elegir ${s.product.sku}`, exact: true });
      const overflow = await dialog.locator('[data-slot="table-container"]').evaluate((el) => {
        const scroller = el.parentElement!;
        return {
          table: el.scrollWidth - el.clientWidth,
          scroller: scroller.scrollWidth - scroller.clientWidth,
        };
      });
      expect(overflow.table, 'la tabla desborda a lo ancho').toBeLessThanOrEqual(0);
      expect(overflow.scroller, 'el contenedor desborda a lo ancho').toBeLessThanOrEqual(0);
      const dialogBox = (await dialog.boundingBox())!;
      const chooseBox = (await choose.boundingBox())!;
      expect(chooseBox.x + chooseBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width);
      await choose.click();
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
