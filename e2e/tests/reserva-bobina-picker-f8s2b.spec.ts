import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import { purgeRoofingTrail, ROOFING_LINE, setupRoofingScenario } from '../helpers/roofing';
import { createCustomer, createQuotationWithLines, type SellableCoilDto } from '../helpers/sales';

/**
 * F8-S2b/M2 — el picker de bobina entera y la reserva temporal propia (D-185).
 *
 * Hallazgo del revisor de F8-S2: `GET /sales/sellable-coils` resta **todo** lo reservado,
 * temporal incluida, sin excluir nunca la reserva de la propia cotización que se está
 * editando. Una cotización con una bobina entera en reserva temporal (D-116 vende el saldo
 * completo) editaba con `<Select>` en blanco: el valor seguía puesto pero la opción había
 * desaparecido de la lista, porque su propia reserva le había dejado el disponible en cero.
 *
 * La regla correcta (y la que valida este archivo, en las dos direcciones): una bobina
 * reservada temporalmente **por esta cotización** es elegible al editarla — es su propia
 * promesa —; reservada por **otra**, sigue sin aparecer.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 120_000 });

function trailOf(s: Awaited<ReturnType<typeof setupRoofingScenario>>) {
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

test.describe('F8-S2b/M2 — picker de bobina y reserva temporal propia', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('D-185: la reserva temporal propia no vacía el picker; la de otra cotización sí sigue ocultando la bobina', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '200' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const quotation = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        items: [{ saleCoilId: s.coil.id, qty: s.coil.availableKg, unitPricePen: '8' }],
      });
      trail.quotationIds.push(quotation.id);
      expect(quotation.items[0]?.reserveItemType).toBe('COIL');

      await postJson(api, `/api/sales/quotations/${quotation.id}/reserve`);

      // Sin excluir a nadie: la propia reserva temporal la descuenta, como siempre.
      const unfiltered = await getJson<SellableCoilDto[]>(api, '/api/sales/sellable-coils');
      expect(unfiltered.find((c) => c.coilId === s.coil.id)).toBeUndefined();

      // Excluir una cotización que no tiene nada reservado sobre esta bobina no la libera:
      // la exclusión es por id, no un interruptor general.
      const wrongExclude = await getJson<SellableCoilDto[]>(
        api,
        `/api/sales/sellable-coils?excludeQuotationId=${randomUUID()}`,
      );
      expect(wrongExclude.find((c) => c.coilId === s.coil.id)).toBeUndefined();

      // Excluir la propia cotización devuelve la bobina, con el saldo completo: es su
      // propia promesa, no la de un tercero.
      const ownExclude = await getJson<SellableCoilDto[]>(
        api,
        `/api/sales/sellable-coils?excludeQuotationId=${quotation.id}`,
      );
      const own = ownExclude.find((c) => c.coilId === s.coil.id);
      expect(own).toMatchObject({ availableQty: '200.000' });
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-185: editar esa cotización desde la pantalla muestra la bobina elegida, no el desplegable en blanco', async ({
    page,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '150' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const quotation = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        items: [{ saleCoilId: s.coil.id, qty: s.coil.availableKg, unitPricePen: '8' }],
      });
      trail.quotationIds.push(quotation.id);
      await postJson(api, `/api/sales/quotations/${quotation.id}/reserve`);

      await loginAsAdmin(page);
      await page.goto(`/cotizaciones/${quotation.id}/editar`);
      const coilSelect = page.getByLabel('Bobina a vender de la línea 1');
      // Antes del fix esto quedaba en blanco (el valor apuntaba a una opción que la lista ya
      // no traía): el trigger de Radix solo pinta la etiqueta de una opción presente.
      await expect(coilSelect).toContainText(s.coil.code, { timeout: 30_000 });
      await expect(coilSelect).toContainText('150', { timeout: 30_000 });
    } finally {
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
