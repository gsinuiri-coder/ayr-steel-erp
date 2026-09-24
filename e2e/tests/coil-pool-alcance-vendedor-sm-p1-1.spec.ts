import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createSupplier, createUser, getJson, postJson } from '../helpers/api';
import { apiAs } from '../helpers/production';
import { buyRoofingCoil, createColor, createRoofingFinish } from '../helpers/roofing';
import { createCustomer, purgeSalesTrail, type QuotationDto } from '../helpers/sales';

/**
 * **SM-P1-1 — aclaración de RF-S3c: el selector de bobina no nombra la cotización de otro
 * vendedor.**
 *
 * `GET /sales/coil-pool` devuelve en `taken` las bobinas del pool que no se ofrecen y por qué.
 * Hasta acá decía «atada a COT-…» a cualquiera, así que un VENDEDOR que editaba su propio
 * documento veía el código de una cotización ajena. Regla del dueño: a un VENDEDOR, la de otro
 * vendedor se muestra «no disponible»; la suya y cualquier rol no VENDEDOR siguen viendo el código.
 */

test.describe.configure({ timeout: 300_000 });

interface CoilPoolDto {
  taken: { code: string; by: string }[];
}

test.describe('SM-P1-1 — coil-pool por vendedor', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('la bobina atada a la cotización de A: A ve el código, B ve «no disponible», el admin el código', async ({
    baseURL,
  }) => {
    const color = await createColor(api, '#0e4c96');
    const finish = await createRoofingFinish(api, { colorId: color.id });
    const supplier = await createSupplier(api, { name: 'E2E Proveedor SM-P1-1' });
    const { coil } = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: color.id,
      weightKg: '900',
      thicknessMm: '0.38',
      widthMm: '1200',
    });
    const catalog = await getJson<{ id: string; sku: string }[]>(api, '/api/catalog');
    const product = catalog.find((p) => p.sku === `BOB038${color.code}`);
    expect(product, 'el alta de la bobina no creó el producto de venta').toBeDefined();

    const customer = await createCustomer(api);
    const sellerA = await apiAs(baseURL!, await createUser(api, 'VENDEDOR'));
    const sellerB = await apiAs(baseURL!, await createUser(api, 'VENDEDOR'));

    const quotationIds: string[] = [];
    try {
      // La venta de la bobina entera la ata a la cotización de A (D-116).
      const quotation = await postJson<QuotationDto>(sellerA, '/api/sales/quotations', {
        customerId: customer.id,
        items: [{ saleCoilId: coil.id, qty: '900.000', unitPricePen: '20.0000' }],
      });
      quotationIds.push(quotation.id);
      expect(quotation.items[0]!.reserveItemId).toBe(coil.id);

      const pool = `/api/sales/coil-pool?productId=${product!.id}&qty=100.000`;
      const takenFor = async (ctx: APIRequestContext) =>
        (await getJson<CoilPoolDto>(ctx, pool)).taken.find((t) => t.code === coil.code);

      expect(await takenFor(sellerA)).toEqual({
        code: coil.code,
        by: `atada a ${quotation.code}`,
      });
      const forB = await takenFor(sellerB);
      expect(forB).toEqual({ code: coil.code, by: 'no disponible' });
      expect(JSON.stringify(forB)).not.toContain(quotation.code);
      expect(await takenFor(api)).toEqual({ code: coil.code, by: `atada a ${quotation.code}` });
    } finally {
      await purgeSalesTrail(api, { quotationIds });
      await sellerA.dispose();
      await sellerB.dispose();
    }
  });
});
