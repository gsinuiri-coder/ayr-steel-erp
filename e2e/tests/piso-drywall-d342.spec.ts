import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson, postJson } from '../helpers/api';
import {
  createCatalogProduct,
  today,
  deactivateTrail,
  postExpectingError,
  setupScenario,
  type Scenario,
} from '../helpers/production';
import { createCustomer, stockPanel } from '../helpers/sales';

/**
 * D-342/D-344 — el piso de precio de un perfil de drywall sale de su **SKU**: kilos de la pieza ×
 * costo por kilo ponderado de los flejes galvanizados de su espesor y su ancho
 * (`computePriceFloors`, D-163). Sin flejes compatibles con saldo no hay piso y el catálogo y el
 * panel de stock dicen «Sin flejes compatibles: sin piso»; nada bloquea.
 *
 * Escribe catálogo, compras, corte y cotizaciones: nunca contra producción (regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 240_000 });

interface FloorDto {
  minPricePen: string | null;
  priceUnitLabel: string | null;
  noFloorReason:
    'NO_THICKNESS' | 'NO_WIDTH' | 'NO_PIECE_WEIGHT' | 'NO_COMPATIBLE_STRIPS' | 'NO_MARGIN' | null;
}

test.describe('D-342/D-344 — piso de drywall desde el SKU', () => {
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

  test('con flejes compatibles con saldo el perfil tiene piso; con otro ancho de fleje no, y se dice por qué', async () => {
    // El perfil del escenario pide el fleje que hay (galvanizado, 0.50 × 600) con saldo.
    const compatible = await floorOf(scenario.product.id);
    expect(compatible.noFloorReason).toBeNull();
    expect(Number(compatible.minPricePen)).toBeGreaterThan(0);
    expect(compatible.priceUnitLabel).toBe('NIU');

    // Otro perfil, con el SKU completo pero que pide un fleje de 700 mm del que no hay ninguno.
    const noStrips = await createCatalogProduct(api, { pieceWeightKg: '2.000', widthMm: '700' });
    extraProductIds.push(noStrips.id);
    await expect(floorOf(noStrips.id)).resolves.toEqual({
      minPricePen: null,
      priceUnitLabel: null,
      noFloorReason: 'NO_COMPATIBLE_STRIPS',
    });
    // Ese motivo depende del saldo de flejes de hoy: no viaja en el catálogo (solo el estático).
    const catalog = await getJson<{ id: string; noFloorReason: string | null }[]>(
      api,
      '/api/catalog',
    );
    expect(catalog.find((p) => p.id === noStrips.id)?.noFloorReason).toBeNull();
    expect(catalog.find((p) => p.id === scenario.product.id)?.noFloorReason).toBeNull();

    // El panel de stock del formulario de cotización dice lo mismo, sin bloquear.
    const panel = await stockPanel(api, {
      businessLine: 'drywall',
      productIds: [scenario.product.id, noStrips.id],
    });
    const rows = panel.products as unknown as {
      productId: string;
      minPricePen: string | null;
      noFloorReason: string | null;
    }[];
    expect(rows.find((r) => r.productId === noStrips.id)).toMatchObject({
      minPricePen: null,
      noFloorReason: 'NO_COMPATIBLE_STRIPS',
    });
    expect(rows.find((r) => r.productId === scenario.product.id)?.noFloorReason).toBeNull();
    expect(rows.find((r) => r.productId === scenario.product.id)?.minPricePen).not.toBeNull();

    // Cotizar el perfil **sin flejes compatibles** a un precio ínfimo no se bloquea (sin costo no
    // hay piso, D-163); el que **sí** los tiene rechaza el mismo precio por debajo de su mínimo.
    const customer = await createCustomer(api);
    const quotationOf = (productId: string) => ({
      customerId: customer.id,
      issueDate: today(),
      items: [{ productId, qty: '1.000', unitPricePen: '0.5' }],
    });
    const cheap = await postJson<{ id: string }>(
      api,
      '/api/sales/quotations',
      quotationOf(noStrips.id),
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

  test('cambiar el espesor del SKU cambia qué flejes cuentan: le quita el piso y, al volver, se lo devuelve', async () => {
    // Sin ninguna OP viva sobre este perfil, el espesor del fleje se puede editar.
    const own = await createCatalogProduct(api, { pieceWeightKg: '2.000' });
    extraProductIds.push(own.id);
    expect((await floorOf(own.id)).noFloorReason).toBeNull();

    const thicker = await api.patch(`/api/catalog/${own.id}`, { data: { thicknessMm: '0.90' } });
    expect(thicker.ok()).toBe(true);
    expect((await floorOf(own.id)).noFloorReason).toBe('NO_COMPATIBLE_STRIPS');

    // Sin tolerancia: 0.51 mm no es 0.50 mm, y tampoco cuenta.
    await api.patch(`/api/catalog/${own.id}`, { data: { thicknessMm: '0.51' } });
    expect((await floorOf(own.id)).noFloorReason).toBe('NO_COMPATIBLE_STRIPS');

    await api.patch(`/api/catalog/${own.id}`, { data: { thicknessMm: '0.50' } });
    const back = await floorOf(own.id);
    expect(back.noFloorReason).toBeNull();
    expect(Number(back.minPricePen)).toBeGreaterThan(0);
  });
});
