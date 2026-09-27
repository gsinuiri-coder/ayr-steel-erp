import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson, postJson } from '../helpers/api';
import {
  createCatalogProduct,
  today,
  deactivateTrail,
  postExpectingError,
  putJson,
  setupScenario,
  upsertBom,
  type Scenario,
} from '../helpers/production';
import { createCustomer, stockPanel } from '../helpers/sales';

/**
 * D-342 — el piso de precio de un perfil de drywall sale de su receta: kilos de la pieza × costo por
 * kilo ponderado de los flejes compatibles (`computePriceFloors`, D-163). Sin receta activa no hay
 * piso y el catálogo y el panel de stock dicen «Sin receta: sin piso de precio»; nada bloquea.
 *
 * Escribe catálogo, compras, corte y cotizaciones: nunca contra producción (regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 240_000 });

interface FloorDto {
  minPricePen: string | null;
  priceUnitLabel: string | null;
  noFloorReason: 'NO_RECIPE' | 'NO_PIECE_WEIGHT' | 'NO_STRIP_COST' | null;
}

test.describe('D-342 — piso de drywall desde la receta', () => {
  let api: APIRequestContext;
  let scenario: Scenario;
  const extraProductIds: string[] = [];

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL);
    scenario = await setupScenario(api);
  });
  test.afterAll(async () => {
    await deactivateTrail(api, {
      cuttingOrderId: scenario.cuttingOrderId,
      motherId: scenario.mother.id,
      purchaseId: scenario.purchaseId,
      supplierId: scenario.supplier.id,
      finish: scenario.finish,
      productIds: [scenario.product.id, ...extraProductIds],
    });
    await api.dispose();
  });

  const floorOf = (productId: string) =>
    getJson<FloorDto>(api, `/api/catalog/${productId}/price-floor`);

  test('con receta activa y flejes con saldo el perfil tiene piso; sin receta no, y se dice por qué', async () => {
    // El perfil del escenario tiene receta y hay flejes abiertos con saldo.
    const withRecipe = await floorOf(scenario.product.id);
    expect(withRecipe.noFloorReason).toBeNull();
    expect(Number(withRecipe.minPricePen)).toBeGreaterThan(0);
    expect(withRecipe.priceUnitLabel).toBe('NIU');

    // Otro perfil, con peso pero **sin receta**: sin piso, y el catálogo lo marca.
    const noRecipe = await createCatalogProduct(api, { pieceWeightKg: '2.000' });
    extraProductIds.push(noRecipe.id);
    await expect(floorOf(noRecipe.id)).resolves.toEqual({
      minPricePen: null,
      priceUnitLabel: null,
      noFloorReason: 'NO_RECIPE',
    });
    const catalog = await getJson<{ id: string; noFloorReason: string | null }[]>(
      api,
      '/api/catalog',
    );
    expect(catalog.find((p) => p.id === noRecipe.id)?.noFloorReason).toBe('NO_RECIPE');
    expect(catalog.find((p) => p.id === scenario.product.id)?.noFloorReason).toBeNull();

    // El panel de stock del formulario de cotización dice lo mismo, sin bloquear.
    const panel = await stockPanel(api, {
      businessLine: 'drywall',
      productIds: [scenario.product.id, noRecipe.id],
    });
    const rows = panel.products as unknown as {
      productId: string;
      minPricePen: string | null;
      noFloorReason: string | null;
    }[];
    expect(rows.find((r) => r.productId === noRecipe.id)).toMatchObject({
      minPricePen: null,
      noFloorReason: 'NO_RECIPE',
    });
    expect(rows.find((r) => r.productId === scenario.product.id)?.noFloorReason).toBeNull();
    expect(rows.find((r) => r.productId === scenario.product.id)?.minPricePen).not.toBeNull();

    // Cotizar el perfil **sin receta** a un precio ínfimo no se bloquea (sin costo no hay piso, D-163);
    // el que **sí** tiene receta rechaza el mismo precio por debajo de su mínimo.
    const customer = await createCustomer(api);
    const quotationOf = (productId: string) => ({
      customerId: customer.id,
      issueDate: today(),
      items: [{ productId, qty: '1.000', unitPricePen: '0.5' }],
    });
    const cheap = await postJson<{ id: string }>(
      api,
      '/api/sales/quotations',
      quotationOf(noRecipe.id),
    );
    expect(cheap.id).toBeTruthy();
    const rejected = await postExpectingError(
      api,
      '/api/sales/quotations',
      quotationOf(scenario.product.id),
    );
    expect(rejected.status).toBe(400);
    expect(rejected.message).toMatch(/precio mínimo/);
  });

  test('desactivar la receta le quita el piso; volver a activarla se lo devuelve', async () => {
    await putJson(api, `/api/production/boms/${scenario.product.id}`, {
      finishId: scenario.finish.id,
      inputThicknessMm: '0.50',
      inputWidthMm: '600',
      isActive: false,
    });
    expect((await floorOf(scenario.product.id)).noFloorReason).toBe('NO_RECIPE');

    await upsertBom(api, scenario.product.id, { finishId: scenario.finish.id });
    const back = await floorOf(scenario.product.id);
    expect(back.noFloorReason).toBeNull();
    expect(Number(back.minPricePen)).toBeGreaterThan(0);
  });

  test('una receta cuyos flejes no tienen saldo dice «sin costo de flejes»', async () => {
    // Otra combinación de fleje (ancho 700 mm) de la que no hay ninguno en almacén.
    const other = await createCatalogProduct(api, { pieceWeightKg: '2.000' });
    extraProductIds.push(other.id);
    await upsertBom(api, other.id, {
      finishId: scenario.finish.id,
      inputThicknessMm: '0.50',
      inputWidthMm: '700',
    });
    await expect(floorOf(other.id)).resolves.toEqual({
      minPricePen: null,
      priceUnitLabel: null,
      noFloorReason: 'NO_STRIP_COST',
    });
  });
});
