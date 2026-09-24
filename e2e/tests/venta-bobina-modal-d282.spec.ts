import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import { purgeRoofingTrail, ROOFING_LINE, setupRoofingScenario } from '../helpers/roofing';
import { createCustomer, createQuotationWithLines } from '../helpers/sales';

/**
 * D-282 — la venta directa de bobina se elige en un modal, como el producto de las otras líneas:
 * con el pool (espesor · color), el acabado/RAL de cada bobina y las que no se ofrecen con su
 * motivo. Antes era un desplegable de códigos sin acabado y sin explicación de las que faltaban.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 150_000 });

interface UnavailableCoil {
  coilId: string;
  code: string;
  reason: string;
}

test.describe('D-282 — modal de venta de bobina', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('elegir «Bobina completa» abre el modal con el acabado y el motivo de las que no se ofrecen', async ({
    page,
  }) => {
    const free = await setupRoofingScenario(api, { weightKg: '120' });
    const held = await setupRoofingScenario(api, { weightKg: '130' });
    const customer = await createCustomer(api);
    const trail = {
      supplierId: free.supplier.id,
      finishId: free.finish.id,
      colorId: free.color.id,
      productIds: [free.product.id],
      coilIds: [free.coil.id],
      purchaseIds: [free.purchaseId],
      orderIds: [] as string[],
      quotationIds: [] as string[],
    };
    const heldTrail = {
      supplierId: held.supplier.id,
      finishId: held.finish.id,
      colorId: held.color.id,
      productIds: [held.product.id],
      coilIds: [held.coil.id],
      purchaseIds: [held.purchaseId],
      orderIds: [] as string[],
      quotationIds: [] as string[],
    };
    try {
      // La segunda bobina queda tomada por la reserva temporal de otra cotización.
      const quotation = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        items: [{ saleCoilId: held.coil.id, qty: held.coil.availableKg, unitPricePen: '8' }],
      });
      heldTrail.quotationIds.push(quotation.id);
      await postJson(api, `/api/sales/quotations/${quotation.id}/reserve`);

      const unavailable = await getJson<UnavailableCoil[]>(
        api,
        '/api/sales/sellable-coils/unavailable',
      );
      const reason = unavailable.find((c) => c.coilId === held.coil.id)?.reason;
      expect(reason).toMatch(/^atada a COT-\d{6} \(reserva temporal\)$/);
      expect(unavailable.find((c) => c.coilId === free.coil.id)).toBeUndefined();

      await loginAsAdmin(page);
      await page.goto('/cotizaciones/nueva');
      await page.getByLabel('Línea de negocio de la línea 1').click();
      await page.getByRole('option', { name: 'Bobina completa (venta directa)' }).click();

      const dialog = page.getByRole('dialog', { name: /Elegir bobina/ });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Filtrar bobinas').fill(free.coil.code);
      await expect(dialog.getByRole('row', { name: `Elegir ${free.coil.code}` })).toContainText(
        free.finish.name,
      );

      await dialog.getByLabel('Filtrar bobinas').fill(held.coil.code);
      const taken = dialog.getByRole('region', { name: 'Bobinas que no se ofrecen' });
      await expect(taken).toContainText(held.coil.code);
      await expect(taken).toContainText(reason!);

      await dialog.getByLabel('Filtrar bobinas').fill(free.coil.code);
      await dialog.getByRole('button', { name: `Elegir ${free.coil.code}` }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByLabel('Bobina a vender de la línea 1')).toContainText(free.coil.code);
      await expect(page.getByLabel('Cantidad de la línea 1')).toHaveValue(free.coil.availableKg);
    } finally {
      await purgeRoofingTrail(api, heldTrail);
      await purgeRoofingTrail(api, trail);
    }
  });
});

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}
