import { expect, test } from '@playwright/test';
import { adminApi, createFinish, createUser, getJson, postJson } from '../helpers/api';
import {
  apiAs,
  balanceOf,
  createCatalogProduct,
  deactivateTrail,
  getExpectingError,
  KG_PER_PIECE,
  live,
  movementsOf,
  optionalBalanceOf,
  postExpectingError,
  purgeProductionOrder,
  putExpectingError,
  setupScenario,
  today,
  uniqueDocumentNumber,
  upsertBom,
  type BusinessLineDto,
  type CoilDto,
  type MovementDto,
  type ProductBomDto,
  type ProductDto,
  type ProductionOrderDto,
  type StripOptionDto,
} from '../helpers/production';

const isProduction = !!process.env.E2E_BASE_URL;
/**
 * Fase 4 — bordes de la producción de drywall (RF-32..35, D-055..D-060).
 *
 * `fase4.spec.ts` cubre el camino feliz y las tres reversas. Acá van los huecos: el
 * reparto FIFO entre dos flejes, lo que `consume` y `report` deben rechazar, `release`,
 * la receta del maestro (D-059), el reparto de permisos (D-046), el motivo de la merma
 * del cierre (D-057) y las dos formas en que la reapertura se bloquea.
 *
 * Todo escenario que cierra una OP la purga (reabrir → revertir → anular) dentro del
 * propio test, así la prueba también sirve contra producción sin dejar stock detrás.
 *
 * Mueve kardex, así que contra producción solo corre con `E2E_ALLOW_WRITES=1` (D-024).
 */
const skipWrites = isProduction && process.env.E2E_ALLOW_WRITES !== '1';

/** Kilo teórico que sale de la geometría del escenario: 600 × 0.50 × 3000 × 7.85 / 1e6. */
const SUGGESTED_KG_PER_PIECE = '7.065';

/** La merma de proceso del cierre apunta a la orden, no a la bobina (D-060/RF-18). */
function processScrap(movements: MovementDto[], orderId: string): MovementDto {
  const scrap = live(movements).find((m) => m.refType === 'SCRAP' && m.refId === orderId);
  expect(scrap, 'El cierre debía dejar una merma de proceso vigente en el fleje').toBeDefined();
  return scrap!;
}

test.describe('Fase 4 — bordes de producción (RF-32..35, D-055..D-060)', () => {
  test.skip(skipWrites, 'Mueve kardex: en produccion solo con E2E_ALLOW_WRITES=1');

  test.beforeEach(() => {
    test.setTimeout(240_000);
  });

  test('un reporte que cruza de un fleje al siguiente reparte FIFO y la suma de las salidas es exactamente el kilo teórico', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupScenario(api);
    let opId = '';

    try {
      const [stripA, stripB] = s.strips as [CoilDto, CoilDto];
      const op = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
        targetPieces: 1000,
      });
      opId = op.id;

      // El primer fleje entra parcial (1 500 de sus 2 400 kg): `qtyKg` es lo que planta
      // usa cuando monta solo una parte del rollo.
      const withA = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/consume`, {
        coilId: stripA.id,
        qtyKg: '1500',
      });
      expect(withA.assignedKg).toBe('1500.000');
      const withB = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/consume`, {
        coilId: stripB.id,
      });
      expect(withB.assignedKg).toBe('3900.000');
      expect(withB.consumptions.map((c) => c.coilId)).toEqual([stripA.id, stripB.id]);

      // --- Reporte que no cabe en el primer fleje: 800 piezas = 1 600 kg ---
      const crossing = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/report`, {
        pieces: 800,
      });
      const report1 = crossing.reports[0]!;
      expect(report1).toMatchObject({
        pieces: 800,
        theoreticalKg: '1600.000',
        // 1 500 kg del primer fleje + 100 kg del segundo, ambos a S/ 4/kg.
        materialCostPen: '6400.0000',
        unitCostPen: '8.0000',
      });
      // FIFO: el primero que se montó es el primero que se gasta, y se gasta entero.
      expect(crossing.consumptions[0]).toMatchObject({
        coilId: stripA.id,
        consumedKg: '1500.000',
        remainingKg: '0.000',
      });
      expect(crossing.consumptions[1]).toMatchObject({
        coilId: stripB.id,
        consumedKg: '100.000',
        remainingKg: '2300.000',
      });
      // Los 900 kg de A que la OP no tomó siguen intactos en el kardex del fleje.
      expect((await balanceOf(api, 'COIL', stripA.id)).qty).toBe('900.000');
      expect((await balanceOf(api, 'COIL', stripB.id)).qty).toBe('2300.000');

      // --- Segundo reporte: el fleje agotado se salta y todo sale del segundo ---
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/report`, { pieces: 200 });
      expect((await balanceOf(api, 'COIL', stripA.id)).qty).toBe('900.000');
      expect((await balanceOf(api, 'COIL', stripB.id)).qty).toBe('1900.000');

      // La suma de lo que salió de los dos flejes es el kilo teórico exacto: el reparto
      // por diferencia no deja milésimas huérfanas (`allocateStripKg`).
      const outA = live(await movementsOf(api, 'COIL', stripA.id)).filter(
        (m) => m.refType === 'PRODUCTION',
      );
      const outB = live(await movementsOf(api, 'COIL', stripB.id)).filter(
        (m) => m.refType === 'PRODUCTION',
      );
      expect(outA.map((m) => m.qty)).toEqual(['1500.000']);
      expect(outB.map((m) => m.qty)).toEqual(['100.000', '400.000']);
      const totalOut = [...outA, ...outB].reduce((acc, m) => acc + Number(m.qty), 0);
      expect(totalOut, '1 000 piezas × 2 kg (D-047)').toBe(2000);

      // --- Cerrar: la merma sale solo del fleje que quedó con saldo asignado ---
      const closed = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/close`, {
        reason: 'Se corta la corrida con el segundo rollo a medias (prueba E2E)',
      });
      expect(closed).toMatchObject({
        status: 'CLOSED',
        piecesReported: 1000,
        scrapKg: '1900.000',
        // (1 500 + 500 + 1 900) kg × S/ 4 = S/ 15 600, todo el material asignado.
        materialCostPen: '15600.0000',
        unitCostPen: '15.6000',
      });
      const scrapA = live(await movementsOf(api, 'COIL', stripA.id)).filter(
        (m) => m.refType === 'SCRAP',
      );
      expect(scrapA, 'El fleje consumido entero no deja merma de proceso').toHaveLength(0);
      expect(processScrap(await movementsOf(api, 'COIL', stripB.id), opId).qty).toBe('1900.000');
      expect(await balanceOf(api, 'PRODUCT', s.product.id)).toMatchObject({
        qty: '1000.000',
        avgCost: '15.6000',
      });

      // --- Y todo se deshace: reabrir, revertir los dos reportes y anular ---
      await purgeProductionOrder(api, opId);
      expect((await balanceOf(api, 'COIL', stripA.id)).qty).toBe('2400.000');
      expect((await balanceOf(api, 'COIL', stripB.id)).qty).toBe('2400.000');
      expect((await balanceOf(api, 'PRODUCT', s.product.id)).qty).toBe('0.000');
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          productionOrderIds: opId ? [opId] : [],
          cuttingOrderId: s.cuttingOrderId,
          motherId: s.mother.id,
          purchaseId: s.purchaseId,
          supplierId: s.supplier.id,
          finish: s.finish,
          productId: s.product.id,
        });
      }
    }
  });

  test('consumir rechaza con 400 un fleje que no coincide con la receta (acabado, ancho o espesor) y una bobina en vez de un fleje', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupScenario(api);
    const otherFinish = await createFinish(api);
    const opIds: string[] = [];
    const productIds: string[] = [];

    try {
      const strip = s.strips[0]!;

      /** Producto con una receta distinta a la del fleje del escenario. */
      const orderForBom = async (bom: {
        finishId: string;
        inputWidthMm?: string;
        inputThicknessMm?: string;
      }): Promise<ProductionOrderDto> => {
        const product = await createCatalogProduct(api, { name: 'Perfil E2E de otra receta' });
        productIds.push(product.id);
        await upsertBom(api, product.id, { ...bom, kgPerPiece: KG_PER_PIECE });
        const op = await postJson<ProductionOrderDto>(api, '/api/production', {
          productId: product.id,
        });
        opIds.push(op.id);
        return op;
      };

      // Otro ancho: el fleje es de 600 mm y la receta pide 500 mm.
      const narrow = await orderForBom({ finishId: s.finish.id, inputWidthMm: '500' });
      const byWidth = await postExpectingError(api, `/api/production/${narrow.id}/consume`, {
        coilId: strip.id,
      });
      expect(byWidth.status).toBe(400);
      expect(byWidth.message).toContain(strip.code);
      expect(byWidth.message).toContain('no coincide con la receta');
      expect(byWidth.message).toContain('500.00 mm de ancho');

      // Otro espesor: el fleje es de 0.50 mm y la receta pide 0.90 mm.
      const thick = await orderForBom({ finishId: s.finish.id, inputThicknessMm: '0.90' });
      const byThickness = await postExpectingError(api, `/api/production/${thick.id}/consume`, {
        coilId: strip.id,
      });
      expect(byThickness.status).toBe(400);
      expect(byThickness.message).toContain('0.90 mm de espesor');

      // Otro acabado: mismas medidas, material distinto.
      const otherCoating = await orderForBom({ finishId: otherFinish.id });
      const byFinish = await postExpectingError(api, `/api/production/${otherCoating.id}/consume`, {
        coilId: strip.id,
      });
      expect(byFinish.status).toBe(400);
      expect(byFinish.message).toContain(`acabado ${otherFinish.code}`);

      // Y una bobina (`kind=COIL`) no entra a la perfiladora aunque coincida en todo lo
      // demás: la línea de drywall consume flejes (D-049).
      const good = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
      });
      opIds.push(good.id);
      const byKind = await postExpectingError(api, `/api/production/${good.id}/consume`, {
        coilId: s.mother.id,
      });
      expect(byKind.status).toBe(400);
      expect(byKind.message).toContain(s.mother.code);
      expect(byKind.message).toContain('es una bobina, no un fleje');

      // Ninguno de los rechazos dejó rastro: el fleje sigue libre y las OP en borrador.
      expect(await getJson<CoilDto>(api, `/api/coils/${strip.id}`)).toMatchObject({
        status: 'OPEN',
        availableKg: '2400.000',
      });
      for (const id of opIds) {
        const op = await getJson<ProductionOrderDto>(api, `/api/production/${id}`);
        expect(op.status).toBe('DRAFT');
        expect(op.consumptions).toHaveLength(0);
      }
      const options = await getJson<StripOptionDto[]>(
        api,
        `/api/production/strips?productId=${s.product.id}`,
      );
      expect(options.some((o) => o.coilId === strip.id)).toBe(true);
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          productionOrderIds: opIds,
          cuttingOrderId: s.cuttingOrderId,
          motherId: s.mother.id,
          purchaseId: s.purchaseId,
          supplierId: s.supplier.id,
          finish: s.finish,
          productId: s.product.id,
          productIds,
        });
        await api
          .patch(`/api/finishes/${otherFinish.id}`, { data: { isActive: false } })
          .catch(() => undefined);
      }
    }
  });

  test('reportar más piezas de las que el material asignado respalda falla con 400 diciendo los kilos que faltan, y pasa al montar otro fleje', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupScenario(api);
    let opId = '';

    try {
      const [stripA, stripB] = s.strips as [CoilDto, CoilDto];
      const op = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
      });
      opId = op.id;
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/consume`, {
        coilId: stripA.id,
      });

      // 1 300 piezas × 2 kg = 2 600 kg contra 2 400 kg asignados.
      const short = await postExpectingError(api, `/api/production/${opId}/report`, {
        pieces: 1300,
      });
      expect(short.status).toBe(400);
      expect(short.message).toContain('2600.000 kg');
      expect(short.message).toContain('2400.000 kg asignados');
      expect(short.message).toContain('consume otro fleje');

      // El rechazo es completo: ni salió material ni entraron piezas.
      expect((await balanceOf(api, 'COIL', stripA.id)).qty).toBe('2400.000');
      expect(await optionalBalanceOf(api, 'PRODUCT', s.product.id)).toBeNull();
      expect(
        (await getJson<ProductionOrderDto>(api, `/api/production/${opId}`)).reports,
      ).toHaveLength(0);

      // Con el segundo fleje montado, el mismo reporte entra y cruza al segundo rollo.
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/consume`, {
        coilId: stripB.id,
      });
      const reported = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/report`, {
        pieces: 1300,
      });
      expect(reported.reports[0]).toMatchObject({ pieces: 1300, theoreticalKg: '2600.000' });
      expect((await balanceOf(api, 'COIL', stripA.id)).qty).toBe('0.000');
      expect((await balanceOf(api, 'COIL', stripB.id)).qty).toBe('2200.000');
      expect((await balanceOf(api, 'PRODUCT', s.product.id)).qty).toBe('1300.000');

      await purgeProductionOrder(api, opId);
      expect((await balanceOf(api, 'PRODUCT', s.product.id)).qty).toBe('0.000');
      expect((await balanceOf(api, 'COIL', stripA.id)).qty).toBe('2400.000');
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          productionOrderIds: opId ? [opId] : [],
          cuttingOrderId: s.cuttingOrderId,
          motherId: s.mother.id,
          purchaseId: s.purchaseId,
          supplierId: s.supplier.id,
          finish: s.finish,
          productId: s.product.id,
        });
      }
    }
  });

  test('liberar un fleje montado por error funciona si no consumió nada y falla con 400 si ya alimentó piezas', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupScenario(api);
    let opId = '';

    try {
      const [stripA, stripB] = s.strips as [CoilDto, CoilDto];
      const op = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
      });
      opId = op.id;
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/consume`, {
        coilId: stripA.id,
      });
      const both = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/consume`, {
        coilId: stripB.id,
      });
      expect(both.assignedKg).toBe('4800.000');
      const rowA = both.consumptions.find((c) => c.coilId === stripA.id)!;
      const rowB = both.consumptions.find((c) => c.coilId === stripB.id)!;

      // 100 piezas = 200 kg, que FIFO saca del primer fleje: el segundo sigue virgen.
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/report`, { pieces: 100 });

      // --- El fleje que no consumió nada se libera ---
      const released = await postJson<ProductionOrderDto>(
        api,
        `/api/production/${opId}/consumptions/${rowB.id}/release`,
      );
      expect(released.assignedKg).toBe('2400.000');
      expect(released.consumptions.find((c) => c.id === rowB.id)?.releasedAt).not.toBeNull();
      // Y vuelve a estar disponible para otra orden (D-060: nunca movió kardex).
      const options = await getJson<StripOptionDto[]>(
        api,
        `/api/production/strips?productId=${s.product.id}`,
      );
      expect(options.some((o) => o.coilId === stripB.id)).toBe(true);
      expect((await balanceOf(api, 'COIL', stripB.id)).qty).toBe('2400.000');

      // Liberarlo dos veces no hace nada.
      const twice = await postExpectingError(
        api,
        `/api/production/${opId}/consumptions/${rowB.id}/release`,
      );
      expect(twice.status).toBe(400);
      expect(twice.message).toContain('ya fue liberado');

      // --- El que ya alimentó piezas no se libera hasta revertir el reporte ---
      const blocked = await postExpectingError(
        api,
        `/api/production/${opId}/consumptions/${rowA.id}/release`,
      );
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain(stripA.code);
      expect(blocked.message).toContain('200.000 kg');
      expect(blocked.message).toContain('revierte esos reportes');

      const current = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      await postJson<ProductionOrderDto>(
        api,
        `/api/production/${opId}/reports/${current.reports[0]!.id}/reverse`,
        { reason: 'Se revierte para poder liberar el fleje (prueba E2E)' },
      );
      const empty = await postJson<ProductionOrderDto>(
        api,
        `/api/production/${opId}/consumptions/${rowA.id}/release`,
      );
      // Sin flejes ni piezas vivas la orden vuelve a borrador (D-058).
      expect(empty).toMatchObject({ status: 'DRAFT', assignedKg: '0.000', piecesReported: 0 });
      expect((await balanceOf(api, 'COIL', stripA.id)).qty).toBe('2400.000');

      // Y en borrador no se cierra ni se reporta: se anula.
      const closing = await postExpectingError(api, `/api/production/${opId}/close`, {});
      expect(closing.status).toBe(400);
      expect(closing.message).toContain('anúlala en vez de cerrarla');
      const reporting = await postExpectingError(api, `/api/production/${opId}/report`, {
        pieces: 10,
      });
      expect(reporting.status).toBe(400);
      expect(reporting.message).toContain('consume material antes de reportar');

      const cancelled = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/cancel`, {
        reason: 'Corrida abortada en la prueba E2E',
      });
      expect(cancelled.status).toBe('CANCELLED');
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          productionOrderIds: opId ? [opId] : [],
          cuttingOrderId: s.cuttingOrderId,
          motherId: s.mother.id,
          purchaseId: s.purchaseId,
          supplierId: s.supplier.id,
          finish: s.finish,
          productId: s.product.id,
        });
      }
    }
  });

  test('la receta sugiere el kilo por pieza desde la geometría, se bloquea con una OP viva y solo admite productos drywall fabricados en piezas (D-059/D-055)', async ({
    baseURL,
  }) => {
    // No necesita material: la receta y la OP en borrador viven en el maestro.
    const api = await adminApi(baseURL!);
    const finish = await createFinish(api);
    const productIds: string[] = [];
    let opId = '';

    try {
      // --- Sin override, el API guarda exactamente el kilo de la geometría (D-047) ---
      const product = await createCatalogProduct(api);
      productIds.push(product.id);
      const suggested = await upsertBom(api, product.id, { finishId: finish.id });
      expect(suggested.kgPerPiece).toBe(SUGGESTED_KG_PER_PIECE);
      expect(suggested.suggestedKgPerPiece).toBe(SUGGESTED_KG_PER_PIECE);

      // Con override, el maestro manda y la sugerencia queda al lado para comparar.
      const overridden = await upsertBom(api, product.id, {
        finishId: finish.id,
        kgPerPiece: KG_PER_PIECE,
      });
      expect(overridden).toMatchObject({
        kgPerPiece: KG_PER_PIECE,
        suggestedKgPerPiece: SUGGESTED_KG_PER_PIECE,
      });

      // --- Con una OP viva la receta no se toca (D-059) ---
      const op = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: product.id,
      });
      opId = op.id;
      const locked = await putExpectingError(api, `/api/production/boms/${product.id}`, {
        finishId: finish.id,
        inputThicknessMm: '0.50',
        inputWidthMm: '600',
        pieceLengthMm: '3000',
        kgPerPiece: '2.500',
      });
      expect(locked.status).toBe(400);
      expect(locked.message).toContain(op.code);
      expect(locked.message).toContain('en curso');
      expect(
        (await getJson<ProductBomDto>(api, `/api/production/boms/${product.id}`)).kgPerPiece,
      ).toBe(KG_PER_PIECE);

      // Anulada la orden, la receta vuelve a ser editable.
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/cancel`, {
        reason: 'Se anula para poder editar la receta (prueba E2E)',
      });
      const edited = await upsertBom(api, product.id, {
        finishId: finish.id,
        kgPerPiece: '2.500',
      });
      expect(edited.kgPerPiece).toBe('2.500');

      // --- Productos que no pueden tener receta en Fase 4 ---
      const lines = await getJson<BusinessLineDto[]>(api, '/api/business-lines');
      const otherLine = lines.find((l) => l.code !== 'drywall' && l.code !== 'services');
      expect(otherLine, 'Hace falta otra línea de negocio para el caso negativo').toBeDefined();

      const cases: { product: ProductDto; expected: string }[] = [];
      cases.push({
        product: await createCatalogProduct(api, {
          lineCode: otherLine!.code,
          name: 'Producto E2E de otra línea',
        }),
        expected: 'línea Drywall',
      });
      cases.push({
        product: await createCatalogProduct(api, {
          source: 'PURCHASED',
          name: 'Producto E2E comprado',
        }),
        expected: 'producto fabricado',
      });
      cases.push({
        product: await createCatalogProduct(api, { unit: 'KGM', name: 'Producto E2E en kilos' }),
        expected: 'unidades (NIU)',
      });

      for (const { product: rejected, expected } of cases) {
        productIds.push(rejected.id);
        const error = await putExpectingError(api, `/api/production/boms/${rejected.id}`, {
          finishId: finish.id,
          inputThicknessMm: '0.50',
          inputWidthMm: '600',
          pieceLengthMm: '3000',
        });
        expect(error.status).toBe(400);
        expect(error.message).toContain(expected);
        // Y sin receta, tampoco se le puede abrir una orden.
        const denied = await postExpectingError(api, '/api/production', { productId: rejected.id });
        expect(denied.status).toBe(400);
      }
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          productionOrderIds: opId ? [opId] : [],
          finish,
          productIds,
        });
      }
    }
  });

  test('un supervisor de planta opera la corrida entera pero no anula la OP ni toca la receta, y un vendedor no entra a producción (D-046, §3.4)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supervisor = await apiAs(baseURL!, await createUser(api, 'SUPERVISOR_PLANTA'));
    const vendedor = await apiAs(baseURL!, await createUser(api, 'VENDEDOR'));
    const s = await setupScenario(api);
    let opId = '';

    try {
      const strip = s.strips[0]!;

      // --- Lo que planta sí puede hacer: crear, consumir, reportar, revertir, cerrar y reabrir ---
      const op = await postJson<ProductionOrderDto>(supervisor, '/api/production', {
        productId: s.product.id,
        targetPieces: 400,
      });
      opId = op.id;
      await postJson<ProductionOrderDto>(supervisor, `/api/production/${opId}/consume`, {
        coilId: strip.id,
        qtyKg: '1000',
      });
      const firstTry = await postJson<ProductionOrderDto>(
        supervisor,
        `/api/production/${opId}/report`,
        { pieces: 300 },
      );
      await postJson<ProductionOrderDto>(
        supervisor,
        `/api/production/${opId}/reports/${firstTry.reports[0]!.id}/reverse`,
        { reason: 'Piezas mal contadas por planta (prueba E2E)' },
      );
      await postJson<ProductionOrderDto>(supervisor, `/api/production/${opId}/report`, {
        pieces: 400,
      });
      const closed = await postJson<ProductionOrderDto>(
        supervisor,
        `/api/production/${opId}/close`,
        {
          reason: 'Sobró rollo al terminar el turno (prueba E2E)',
        },
      );
      expect(closed).toMatchObject({ status: 'CLOSED', scrapKg: '200.000' });
      // D-060: reabrir sigue siendo de planta, porque el ajuste que revierte es derivado.
      const reopened = await postJson<ProductionOrderDto>(
        supervisor,
        `/api/production/${opId}/reopen`,
        { reason: 'Se reabre la corrida desde planta (prueba E2E)' },
      );
      expect(reopened.status).toBe('IN_PROGRESS');

      // --- Lo que no: anular la orden y cargar la receta son de ADMINISTRADOR ---
      const cancelDenied = await postExpectingError(supervisor, `/api/production/${opId}/cancel`, {
        reason: 'Intento de anulación desde planta (prueba E2E)',
      });
      expect(cancelDenied.status).toBe(403);
      const bomDenied = await putExpectingError(
        supervisor,
        `/api/production/boms/${s.product.id}`,
        {
          finishId: s.finish.id,
          inputThicknessMm: '0.50',
          inputWidthMm: '600',
          pieceLengthMm: '3000',
          kgPerPiece: '3.000',
        },
      );
      expect(bomDenied.status).toBe(403);
      // La receta quedó como estaba.
      expect(
        (await getJson<ProductBomDto>(api, `/api/production/boms/${s.product.id}`)).kgPerPiece,
      ).toBe(KG_PER_PIECE);

      // --- Y un vendedor no llega a ninguna ruta de producción (§3.4) ---
      for (const path of [
        '/api/production',
        '/api/production/boms',
        `/api/production/${opId}`,
        `/api/production/strips?productId=${s.product.id}`,
      ]) {
        expect((await getExpectingError(vendedor, path)).status, `GET ${path}`).toBe(403);
      }
      const vendedorCreate = await postExpectingError(vendedor, '/api/production', {
        productId: s.product.id,
      });
      expect(vendedorCreate.status).toBe(403);
      expect(vendedorCreate.message).toContain('permiso');
      const vendedorReport = await postExpectingError(vendedor, `/api/production/${opId}/report`, {
        pieces: 1,
      });
      expect(vendedorReport.status).toBe(403);

      // Planta revierte lo suyo y el administrador cierra el ciclo anulando.
      const stillLive = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      for (const report of stillLive.reports.filter((r) => r.status === 'ACTIVE').reverse()) {
        await postJson<ProductionOrderDto>(
          supervisor,
          `/api/production/${opId}/reports/${report.id}/reverse`,
          { reason: 'Limpieza de la prueba E2E' },
        );
      }
      const cancelled = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/cancel`, {
        reason: 'Cierre de la prueba E2E',
      });
      expect(cancelled.status).toBe('CANCELLED');
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('2400.000');
    } finally {
      await supervisor.dispose();
      await vendedor.dispose();
      if (isProduction) {
        await deactivateTrail(api, {
          productionOrderIds: opId ? [opId] : [],
          cuttingOrderId: s.cuttingOrderId,
          motherId: s.mother.id,
          purchaseId: s.purchaseId,
          supplierId: s.supplier.id,
          finish: s.finish,
          productId: s.product.id,
        });
      }
    }
  });

  test('cerrar con poca merma no pide motivo; con mucha, el motivo escrito queda en el kardex de la merma de proceso (D-057)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupScenario(api);
    let normalId = '';
    let heavyId = '';

    try {
      const [stripA, stripB] = s.strips as [CoilDto, CoilDto];

      // --- Corrida normal: 990 kg en piezas y 10 kg de recorte = 1 % ---
      const normal = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
      });
      normalId = normal.id;
      await postJson<ProductionOrderDto>(api, `/api/production/${normalId}/consume`, {
        coilId: stripA.id,
        qtyKg: '1000',
      });
      await postJson<ProductionOrderDto>(api, `/api/production/${normalId}/report`, {
        pieces: 495,
      });
      const closedNormal = await postJson<ProductionOrderDto>(
        api,
        `/api/production/${normalId}/close`,
        {},
      );
      expect(closedNormal).toMatchObject({
        status: 'CLOSED',
        scrapKg: '10.000',
        materialCostPen: '4000.0000',
        // S/ 4 000 / 495 piezas: la merma la absorben las piezas (D-056).
        unitCostPen: '8.0808',
      });
      const normalScrap = processScrap(await movementsOf(api, 'COIL', stripA.id), normalId);
      expect(normalScrap.qty).toBe('10.000');
      expect(normalScrap.notes).toBe(`Merma de proceso al cerrar ${normal.code}`);

      // --- Corrida con merma grande: el motivo es obligatorio y viaja al kardex ---
      const heavy = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
      });
      heavyId = heavy.id;
      await postJson<ProductionOrderDto>(api, `/api/production/${heavyId}/consume`, {
        coilId: stripB.id,
      });
      await postJson<ProductionOrderDto>(api, `/api/production/${heavyId}/report`, { pieces: 100 });
      const sinMotivo = await postExpectingError(api, `/api/production/${heavyId}/close`, {});
      expect(sinMotivo.status).toBe(400);
      expect(sinMotivo.message).toContain('2200.000 kg de merma');

      const reason = 'Rollo deformado: se descarta el resto de la bobina (prueba E2E)';
      const closedHeavy = await postJson<ProductionOrderDto>(
        api,
        `/api/production/${heavyId}/close`,
        { reason },
      );
      expect(closedHeavy).toMatchObject({ status: 'CLOSED', scrapKg: '2200.000' });
      const heavyScrap = processScrap(await movementsOf(api, 'COIL', stripB.id), heavyId);
      expect(heavyScrap.qty).toBe('2200.000');
      expect(heavyScrap.notes).toBe(`Merma de proceso al cerrar ${heavy.code}: ${reason}`);
      expect(heavyScrap.type).toBe('OUT');

      // --- Limpieza, de la última a la primera: el ajuste de la última bloquea a la anterior ---
      await purgeProductionOrder(api, heavyId);
      await purgeProductionOrder(api, normalId);
      expect((await balanceOf(api, 'COIL', stripA.id)).qty).toBe('2400.000');
      expect((await balanceOf(api, 'COIL', stripB.id)).qty).toBe('2400.000');
      expect((await balanceOf(api, 'PRODUCT', s.product.id)).qty).toBe('0.000');
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          productionOrderIds: [normalId, heavyId].filter(Boolean),
          cuttingOrderId: s.cuttingOrderId,
          motherId: s.mother.id,
          purchaseId: s.purchaseId,
          supplierId: s.supplier.id,
          finish: s.finish,
          productId: s.product.id,
        });
      }
    }
  });

  test('la merma de proceso del cierre no se anula desde el kardex (RF-18): solo reabriendo la OP, y una merma normal del fleje sí se anula', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupScenario(api);
    let opId = '';

    try {
      const strip = s.strips[0]!;
      const op = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
      });
      opId = op.id;
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/consume`, {
        coilId: strip.id,
        qtyKg: '1000',
      });
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/report`, { pieces: 400 });
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/close`, {
        reason: 'Sobró rollo al cerrar (prueba E2E)',
      });
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('1400.000');

      // La merma del cierre tiene la misma firma que una merma de RF-17 (`SCRAP` sobre un
      // COIL), pero apunta a la orden: anularla devolvería kilos y valor al fleje mientras
      // las piezas conservan el costo absorbido (D-056), o sea valor de la nada.
      const processMovement = processScrap(await movementsOf(api, 'COIL', strip.id), opId);
      const blocked = await postExpectingError(
        api,
        `/api/coils/scraps/${processMovement.id}/cancel`,
        { reason: 'Intento de anular la merma de proceso desde el kardex (prueba E2E)' },
      );
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain('merma de proceso');
      expect(blocked.message).toContain('reabre la orden');
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('1400.000');

      // El camino correcto: reabrir la OP devuelve esos kilos.
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/reopen`, {
        reason: 'Se reabre para deshacer la merma de proceso (prueba E2E)',
      });
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('1600.000');
      await purgeProductionOrder(api, opId);
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('2400.000');

      // Y el bloqueo distingue por `refId`, no bloquea toda merma: una merma normal del
      // fleje (RF-17) se sigue anulando sin problema (RF-18).
      const scrapped = await postJson<CoilDto>(api, `/api/coils/${strip.id}/scrap`, {
        qtyKg: '10',
        reason: 'Merma normal del fleje (prueba E2E)',
      });
      expect(scrapped.availableKg).toBe('2390.000');
      const ownScrap = live(await movementsOf(api, 'COIL', strip.id)).find(
        (m) => m.refType === 'SCRAP' && m.refId === strip.id,
      )!;
      expect(ownScrap).toBeDefined();
      const restored = await postJson<CoilDto>(api, `/api/coils/scraps/${ownScrap.id}/cancel`, {
        reason: 'Se anula la merma mal registrada (prueba E2E)',
      });
      expect(restored.availableKg).toBe('2400.000');
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          productionOrderIds: opId ? [opId] : [],
          cuttingOrderId: s.cuttingOrderId,
          motherId: s.mother.id,
          purchaseId: s.purchaseId,
          supplierId: s.supplier.id,
          finish: s.finish,
          productId: s.product.id,
        });
      }
    }
  });

  test('un fleje montado en una OP bloquea también la factura del servicio de corte (RF-41/D-060), que subiría su costo a mitad de corrida', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupScenario(api);
    let opId = '';
    let invoiceId = '';

    try {
      const strip = s.strips[0]!;
      const op = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
      });
      opId = op.id;
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/consume`, {
        coilId: strip.id,
      });

      // La factura del corte se registra sin problema: el prorrateo ocurre al recibirla.
      const invoice = await postJson<{ id: string; status: string }>(api, '/api/purchases', {
        supplierId: s.supplier.id,
        businessLine: 'drywall',
        type: 'SERVICE',
        docType: 'FACTURA',
        series: 'F001',
        number: uniqueDocumentNumber(),
        issueDate: today(),
        currency: 'PEN',
        igvRate: '18',
        paymentTerms: 'CONTADO',
        serviceKind: 'CUTTING',
        relatedCuttingOrderId: s.cuttingOrderId,
        items: [{ description: 'Servicio de corte E2E', qty: '1', unit: 'ZZ', unitPrice: '500' }],
      });
      invoiceId = invoice.id;

      // Recibirla imputaría su costo a los flejes de la orden de corte con un `ADJUST`
      // (RF-41): los reportes previos de la OP habrían salido a un costo y los siguientes
      // a otro. Es la misma razón por la que D-045 ya bloquea recostear a mano.
      const blocked = await postExpectingError(api, `/api/purchases/${invoiceId}/receive`);
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain(strip.code);
      expect(blocked.message).toContain(op.code);
      expect(blocked.message).toContain('imputar el costo del corte');

      // Nada se movió: el fleje conserva su costo y la compra sigue en borrador.
      const stripMovements = live(await movementsOf(api, 'COIL', strip.id));
      expect(stripMovements.some((m) => m.type === 'ADJUST')).toBe(false);
      expect((await balanceOf(api, 'COIL', strip.id)).avgCost).toBe('4.0000');
      expect((await getJson<{ status: string }>(api, `/api/purchases/${invoiceId}`)).status).toBe(
        'DRAFT',
      );

      // Anulada la orden el camino queda libre; no se recibe la factura para no dejar un
      // `ADJUST` de prueba sobre el costo de los flejes.
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/cancel`, {
        reason: 'Cierre de la prueba E2E',
      });
    } finally {
      if (invoiceId) {
        await api
          .post(`/api/purchases/${invoiceId}/cancel`, {
            data: { reason: 'Limpieza de la prueba E2E' },
          })
          .catch(() => undefined);
      }
      if (isProduction) {
        await deactivateTrail(api, {
          productionOrderIds: opId ? [opId] : [],
          cuttingOrderId: s.cuttingOrderId,
          motherId: s.mother.id,
          purchaseId: s.purchaseId,
          supplierId: s.supplier.id,
          finish: s.finish,
          productId: s.product.id,
        });
      }
    }
  });

  /**
   * Regresión del defecto que encontró `qa` al cerrar Fase 4: `split()` (RF-15) creaba
   * las hijas sin pasar `kind`, y la columna tiene `@default(COIL)`. Partir un **fleje**
   * para reancharlo devolvía hijas `kind=COIL`, así que ese material se caía del stock de
   * flejes (RF-42 filtra por `kind=STRIP`), `ProductionService.consume` lo rechazaba con
   * "es una bobina, no un fleje" y el guardrail de D-060 sobre las hijas de un partido
   * quedaba inalcanzable. Ahora la hija hereda la clase de la madre.
   */
  test('partir un fleje (RF-15) devuelve hijas kind=STRIP, que siguen entrando a producción (D-049)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupScenario(api);
    let splitId = '';
    let opId = '';

    try {
      const strip = s.strips[1]!;
      expect(strip.kind, 'La madre del partido es un fleje').toBe('STRIP');
      // Se parte una porción del LARGO del rollo (D-041), así que la hija conserva el
      // ancho de la madre — y con él, la coincidencia con la receta del perfil.
      const children = await postJson<CoilDto[]>(api, `/api/coils/${strip.id}/split`, {
        splitWeightKg: '100',
        kerfLossMm: '0',
        children: [{ widthMm: '600', count: 1 }],
      });
      const splits = await getJson<{ id: string }[]>(api, `/api/coils/${strip.id}/splits`);
      splitId = splits[0]!.id;

      const child = children[0]!;
      expect(child, 'La hija de un fleje sigue siendo un fleje (D-049)').toMatchObject({
        kind: 'STRIP',
        widthMm: '600.00',
      });

      // Y por eso mismo entra a producción: antes del fix, `consume` la rechazaba con
      // "es una bobina, no un fleje" y ese material no se podía perfilar nunca.
      const op = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
      });
      opId = op.id;
      const consumed = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/consume`, {
        coilId: child.id,
      });
      expect(consumed.consumptions[0]?.coilId).toBe(child.id);

      // Con la hija montada, el guardrail de D-060 sobre `revertSplit` (RF-16) ya es
      // alcanzable: antes del fix ninguna hija de partido podía estar en una OP.
      const blocked = await postExpectingError(api, `/api/coils/splits/${splitId}/revert`, {
        reason: 'Se intenta revertir el partido con la hija montada (prueba E2E)',
      });
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain(child.code);
      expect(blocked.message).toContain(op.code);

      // Liberada la hija, el partido vuelve a poder revertirse.
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/cancel`, {
        reason: 'Cierre de la prueba E2E',
      });
      const reverted = await postJson<{ id: string; status: string }[]>(
        api,
        `/api/coils/splits/${splitId}/revert`,
        { reason: 'Cierre de la prueba E2E' },
      );
      expect(reverted[0]?.status).toBe('REVERTED');
      splitId = '';
    } finally {
      if (opId) {
        await api
          .post(`/api/production/${opId}/cancel`, { data: { reason: 'Limpieza de prueba E2E' } })
          .catch(() => undefined);
      }
      if (splitId) {
        await api
          .post(`/api/coils/splits/${splitId}/revert`, {
            data: { reason: 'Limpieza de la prueba E2E' },
          })
          .catch(() => undefined);
      }
      if (isProduction) {
        await deactivateTrail(api, {
          cuttingOrderId: s.cuttingOrderId,
          motherId: s.mother.id,
          purchaseId: s.purchaseId,
          supplierId: s.supplier.id,
          finish: s.finish,
          productId: s.product.id,
        });
      }
    }
  });

  test('reabrir se bloquea con 400 si el fleje se cerró (RF-19) o si tuvo movimientos después del cierre, y pasa al deshacerlos', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupScenario(api);
    let opId = '';

    try {
      const strip = s.strips[0]!;
      const op = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
      });
      opId = op.id;
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/consume`, {
        coilId: strip.id,
        qtyKg: '1000',
      });
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/report`, { pieces: 400 });
      await postJson<ProductionOrderDto>(api, `/api/production/${opId}/close`, {
        reason: 'Sobró rollo al cerrar (prueba E2E)',
      });

      // --- Caso 1: el fleje se cerró (RF-19) mientras la OP estaba cerrada ---
      // El guardrail de D-060 ya no lo protege: cerrar la OP lo liberó.
      const closedCoil = await postJson<CoilDto>(api, `/api/coils/${strip.id}/status`, {
        status: 'CLOSED',
        reason: 'El fleje se guarda tras la corrida (prueba E2E)',
      });
      expect(closedCoil.status).toBe('CLOSED');
      const byStatus = await postExpectingError(api, `/api/production/${opId}/reopen`, {
        reason: 'Intento de reabrir con el fleje cerrado (prueba E2E)',
      });
      expect(byStatus.status).toBe(400);
      expect(byStatus.message).toContain(strip.code);
      expect(byStatus.message).toContain('CLOSED');
      // Nada se movió: la OP sigue cerrada con su merma emitida.
      expect((await getJson<ProductionOrderDto>(api, `/api/production/${opId}`)).status).toBe(
        'CLOSED',
      );
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('1400.000');
      await postJson<CoilDto>(api, `/api/coils/${strip.id}/status`, {
        status: 'OPEN',
        reason: 'Se vuelve a abrir el fleje (prueba E2E)',
      });

      // --- Caso 2: el fleje se movió después del cierre (una merma de RF-17) ---
      const scrapped = await postJson<CoilDto>(api, `/api/coils/${strip.id}/scrap`, {
        qtyKg: '10',
        reason: 'Merma posterior al cierre de la OP (prueba E2E)',
      });
      expect(scrapped.availableKg).toBe('1390.000');
      const byMovement = await postExpectingError(api, `/api/production/${opId}/reopen`, {
        reason: 'Intento de reabrir con movimientos posteriores (prueba E2E)',
      });
      expect(byMovement.status).toBe(400);
      expect(byMovement.message).toContain('movimientos posteriores al cierre');
      expect(byMovement.message).toContain('SCRAP');

      // Anulada esa merma (RF-18), la reapertura pasa y devuelve la merma de proceso.
      const ownScrap = live(await movementsOf(api, 'COIL', strip.id)).find(
        (m) => m.refType === 'SCRAP' && m.refId === strip.id,
      )!;
      await postJson<CoilDto>(api, `/api/coils/scraps/${ownScrap.id}/cancel`, {
        reason: 'Se anula la merma para poder reabrir la OP (prueba E2E)',
      });
      const reopened = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/reopen`, {
        reason: 'Se reabre la corrida ya destrabada (prueba E2E)',
      });
      expect(reopened).toMatchObject({ status: 'IN_PROGRESS', scrapKg: null, piecesReported: 400 });
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('1600.000');

      await purgeProductionOrder(api, opId);
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('2400.000');
      expect((await balanceOf(api, 'PRODUCT', s.product.id)).qty).toBe('0.000');
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          productionOrderIds: opId ? [opId] : [],
          cuttingOrderId: s.cuttingOrderId,
          motherId: s.mother.id,
          purchaseId: s.purchaseId,
          supplierId: s.supplier.id,
          finish: s.finish,
          productId: s.product.id,
        });
      }
    }
  });
});
