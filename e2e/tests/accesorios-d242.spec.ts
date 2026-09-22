import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson, postJson } from '../helpers/api';
import { balanceOf, postExpectingError, type ProductionOrderDto } from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  buyRoofingCoil,
  createColor,
  createRoofingFinish,
  createRoofingProduct,
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrderLines,
  reportPieces,
  COIL_WIDTH,
} from '../helpers/roofing';
import { businessLineId, createCuttingSupplier } from '../helpers/production';

/**
 * D-242 — accesorios de cobertura (cumbrera, canaleta, tapajunta), por API.
 *
 * Lo que protege, en una línea: **una pasada usa el ancho completo de la bobina y devuelve
 * `N = piso(ancho ÷ desarrollo)` piezas**, así que los metros que entran al kardex son `N`
 * veces los del largo tipeado y los kilos que salen son los de la pasada entera, con el canto
 * adentro. Si alguna de las dos cuentas se separa de la otra, el kardex deja de cuadrar.
 *
 * Aritmética a mano, con la geometría de los helpers (1 000 mm × 0.50 mm, densidad 8.0 y el
 * 1 % de D-165 ⇒ 4.04 kg por metro de **ancho completo**):
 *
 * - desarrollo 250 mm ⇒ N = 4, ancho efectivo 250 mm, 1.01 kg por metro de accesorio;
 * - una pasada de 4 m ⇒ 4 piezas, 16 m de accesorio, 16.16 kg de bobina.
 */

const allowWrites = !process.env.E2E_BASE_URL;
test.skip(!allowWrites, 'Crea compras, bobinas y producción: nunca contra producción (D-126).');
test.describe.configure({ timeout: 240_000 });

/** Desarrollo que divide exacto el ancho de los helpers: 1 000 ÷ 250 = 4 piezas por pasada. */
const DEVELOPMENT = '250.00';

async function setup(
  api: APIRequestContext,
  options: { developmentMm?: string; coilWidthMm?: string } = {},
) {
  const color = await createColor(api);
  const finish = await createRoofingFinish(api, { colorId: color.id });
  const supplier = await createCuttingSupplier(api);
  const { product } = await createRoofingProduct(api, {
    finishId: finish.id,
    colorId: color.id,
    developmentMm: options.developmentMm ?? DEVELOPMENT,
  });
  const { coil, purchaseId } = await buyRoofingCoil(api, {
    supplierId: supplier.id,
    finishId: finish.id,
    colorId: color.id,
    weightKg: '2000',
    ...(options.coilWidthMm === undefined ? {} : { widthMm: options.coilWidthMm }),
  });
  const customer = await createCustomer(api);
  // El pedido pide **metros de accesorio**: 8 piezas de 4 m = 32 m.
  const { quotation, order } = await quoteAndOrderLines(api, {
    customerId: customer.id,
    lines: [{ productId: product.id, rows: pieces([4, 8]) }],
  });
  const opId = order.reservations[0]!.productionOrderId!;
  const trail: Parameters<typeof purgeRoofingTrail>[1] = {
    supplierId: supplier.id,
    finishId: finish.id,
    colorId: color.id,
    productIds: [product.id],
    coilIds: [coil.id],
    purchaseIds: [purchaseId],
    productionOrderIds: [opId],
    orderIds: [order.id],
    quotationIds: [quotation.id],
  };
  return { product, coil, order, opId, trail };
}

test.describe('D-242 — accesorios de cobertura (API)', () => {
  let api: APIRequestContext;
  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  test('el catálogo exige el desarrollo, lo valida contra el ancho y lo rechaza fuera de un accesorio', async () => {
    const color = await createColor(api);
    const finish = await createRoofingFinish(api, { colorId: color.id });
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      finishId: finish.id,
      colorId: color.id,
      productIds: [],
    };
    try {
      const lineId = await businessLineId(api, 'metallic-roofing');

      const base = {
        businessLineId: lineId,
        name: 'Cumbrera E2E',
        unit: 'MTR',
        source: 'MANUFACTURED',
        listPricePen: '30',
        finishId: finish.id,
        colorId: color.id,
        thicknessMm: '0.50',
        widthMm: COIL_WIDTH,
        roofingKind: 'ACCESORIO',
      };

      // Sin desarrollo no se puede producir: no hay forma de saber qué rinde una pasada.
      const noDevelopment = await postExpectingError(api, '/api/catalog', {
        ...base,
        sku: `E2E-ACCX1${Date.now().toString().slice(-4)}`,
      });
      expect(noDevelopment.message).toMatch(/desarrollo del accesorio es obligatorio/i);

      // Un desarrollo más ancho que el rollo no da ni una pieza.
      const tooWide = await postExpectingError(api, '/api/catalog', {
        ...base,
        sku: `E2E-ACCX2${Date.now().toString().slice(-4)}`,
        developmentMm: '1500.00',
      });
      expect(tooWide.message).toMatch(/no da ni una pieza por pasada/i);

      // Y el desarrollo es exactamente del accesorio: en una cobertura a medida no significa nada.
      const notAccessory = await postExpectingError(api, '/api/catalog', {
        ...base,
        sku: `E2E-ACCX3${Date.now().toString().slice(-4)}`,
        roofingKind: 'A_MEDIDA',
        developmentMm: DEVELOPMENT,
      });
      expect(notAccessory.message).toMatch(/desarrollo solo aplica a un accesorio/i);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('el SKU nace con sus piezas por pasada y su kg por metro, que es el del ancho efectivo', async () => {
    const { product, trail } = await setup(api);
    try {
      // 1 000 ÷ 250 = 4 piezas por pasada, con el ancho nominal del catálogo.
      expect(product.piecesPerPass).toBe(4);
      expect(product.developmentMm).toBe('250.00');
      // El kg por metro **vendido** es el del ancho efectivo (250 mm), no el del rollo:
      // 250 × 0.50 × 1000 × 8.08 / 1e6 = 1.01 kg/m.
      expect(product.theoreticalKgPerUnit).toBe('1.010');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('una pasada rinde N piezas: el kardex recibe los metros de todas y la bobina pierde el ancho completo', async () => {
    const { product, coil, opId, trail } = await setup(api);
    try {
      await mountCoil(api, opId, { coilId: coil.id });

      expect((await balanceOf(api, 'COIL', coil.id)).qty).toBe('2000.000');

      // **Dos pasadas de 4 m**, que es lo que planta tipea. Salen 8 piezas y 32 m.
      const order = await reportPieces(api, opId, {
        coilId: coil.id,
        pieces: pieces([4, 2]),
      });

      const report = order.reports.filter((r) => r.status === 'ACTIVE').at(-1)!;
      // Se persisten **piezas**, no pasadas (D-c): 8 de 4 m.
      expect(report.piecesDetail).toEqual([{ lengthMm: '4000.00', qty: 8 }]);
      expect(report.metersM).toBe('32.000');
      // 2 pasadas × 4 m × 1 000 mm de ancho completo = 32.320 kg. Con el ancho efectivo y
      // las 8 piezas sale el mismo número: es la invariante de D-b.
      expect(report.theoreticalKg).toBe('32.320');

      // 2 000 − 32.320 de bobina; 32 m de accesorio donde antes no había saldo.
      expect((await balanceOf(api, 'COIL', coil.id)).qty).toBe('1967.680');
      expect((await balanceOf(api, 'PRODUCT', product.id)).qty).toBe('32.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('el plan es un tope duro contando las piezas que salen, no las pasadas tipeadas', async () => {
    // Plan de 32 m. Dos pasadas ya lo cubren; una tercera se pasa aunque "3 pasadas" suene a poco.
    const { coil, opId, trail } = await setup(api);
    try {
      await mountCoil(api, opId, { coilId: coil.id });
      await reportPieces(api, opId, { coilId: coil.id, pieces: pieces([4, 2]) });

      const overrun = await postExpectingError(api, `/api/production/roofing/${opId}/report`, {
        coilId: coil.id,
        pieces: pieces([4, 1]),
      });
      expect(overrun.message).toMatch(/plan de 32\.000 m/);
      expect(overrun.message).toMatch(/32\.000 m ya reportados/);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('ajuste 1: con el rollo más ancho cambia N, manda el rollo y el aviso queda en el reporte', async () => {
    // Desarrollo 305 mm: el catálogo (1 000 mm) da 3 piezas por pasada; el rollo real de
    // 1 220 mm da 4. Producir con el número de la cotización sería reportar metros que no
    // salieron, así que manda el rollo — y el aviso tiene que verse.
    const { coil, opId, trail } = await setup(api, {
      developmentMm: '305.00',
      coilWidthMm: '1220',
    });
    try {
      await mountCoil(api, opId, { coilId: coil.id });

      // La bobina montada declara su rendimiento real en la pestaña de planta.
      const batch = await getJson<{ coils: { piecesPerPass: number | null }[] }[]>(
        api,
        `/api/production/roofing/batch`,
      );
      const mounted = batch.flatMap((o) => o.coils).find((c) => c.piecesPerPass !== null);
      expect(mounted?.piecesPerPass).toBe(4);

      const order = await reportPieces(api, opId, { coilId: coil.id, pieces: pieces([4, 1]) });
      const report = order.reports.filter((r) => r.status === 'ACTIVE').at(-1)!;
      // 4 piezas, no 3: el rollo que hay es el que manda.
      expect(report.piecesDetail).toEqual([{ lengthMm: '4000.00', qty: 4 }]);
      expect(report.metersM).toBe('16.000');
      // Y el aviso quedó anotado en la fila, no solo en el log (D-154).
      expect(report.rawMaterialWarning).toMatch(/da 4 piezas por pasada/);
      expect(report.rawMaterialWarning).toMatch(/daban 3/);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('revertir el reporte devuelve los metros del accesorio y los kilos de la pasada', async () => {
    const { product, coil, opId, trail } = await setup(api);
    try {
      await mountCoil(api, opId, { coilId: coil.id });

      const order = await reportPieces(api, opId, { coilId: coil.id, pieces: pieces([4, 2]) });
      const reportId = order.reports.filter((r) => r.status === 'ACTIVE').at(-1)!.id;

      await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${opId}/reports/${reportId}/reverse`,
        { reason: 'E2E: la pasada salió mal y se rehace' },
      );

      // El kardex es append-only: la reversa son movimientos inversos, así que los saldos
      // vuelven exactos aunque las filas queden.
      expect((await balanceOf(api, 'COIL', coil.id)).qty).toBe('2000.000');
      expect((await balanceOf(api, 'PRODUCT', product.id)).qty).toBe('0.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
