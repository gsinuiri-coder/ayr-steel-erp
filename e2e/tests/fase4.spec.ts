import { expect, test } from '@playwright/test';
import { adminApi, getJson, postJson } from '../helpers/api';
import {
  balanceOf,
  deactivateTrail,
  live,
  movementsOf,
  postExpectingError,
  setupScenario,
  type CoilDto,
  type ProductionOrderDto,
  type StripOptionDto,
} from '../helpers/production';

const isProduction = !!process.env.E2E_BASE_URL;
/**
 * Fase 4: orden de producción de drywall (RF-32..35, D-055..D-060).
 *
 * Modelo bajo prueba: la OP toma flejes sin mover kardex (D-060), cada reporte de piezas
 * emite la salida del fleje por su kilo teórico y la entrada de las piezas al producto
 * terminado (unidad PIEZAS, D-055), y el cierre saca por diferencia la merma de proceso
 * (D-057) y reparte todo el material entre las piezas buenas (D-056).
 *
 * El escenario, los DTO y la limpieza viven en `e2e/helpers/production.ts`: los comparte
 * con `fase4-bordes.spec.ts`.
 *
 * Mueve kardex, así que contra producción solo corre con `E2E_ALLOW_WRITES=1` (D-024).
 */
const skipWrites = isProduction && process.env.E2E_ALLOW_WRITES !== '1';

test.describe('Fase 4 — producción de drywall (RF-34/RF-35, D-055..D-060)', () => {
  test.skip(skipWrites, 'Mueve kardex: en produccion solo con E2E_ALLOW_WRITES=1');

  test.beforeEach(() => {
    test.setTimeout(180_000);
  });

  test('OP completa: consumir fleje → reportar en dos parciales → cerrar con merma por diferencia; el kardex y el costo cuadran hasta la bobina madre', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupScenario(api);
    let opId = '';

    try {
      const strip = s.strips[0]!;

      // El fleje aparece como opción para ese perfil, con las piezas que alcanza.
      const options = await getJson<StripOptionDto[]>(
        api,
        `/api/production/strips?productId=${s.product.id}`,
      );
      const option = options.find((o) => o.coilId === strip.id)!;
      expect(option).toBeDefined();
      // 2 400 kg / 2 kg por pieza = 1 200 piezas.
      expect(option.estimatedPieces).toBe(1200);

      // --- Crear la OP ---
      const created = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
        targetPieces: 900,
        notes: 'Corrida E2E de Fase 4',
      });
      opId = created.id;
      expect(created.status).toBe('DRAFT');
      expect(created.code).toMatch(/^OP-\d{6}$/);

      // --- Consumir el fleje: D-060, no mueve kardex ---
      const stripMovementsBefore = await movementsOf(api, 'COIL', strip.id);
      const consumed = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/consume`, {
        coilId: strip.id,
      });
      expect(consumed.status).toBe('IN_PROGRESS');
      expect(consumed.assignedKg).toBe('2400.000');
      const assignment = consumed.consumptions[0]!;
      // Trazabilidad hasta la bobina madre (RF-15/RF-41): el fleje la trae consigo.
      expect(assignment.parentCoilId).toBe(s.mother.id);
      expect(assignment.parentCoilCode).toBe(s.mother.code);
      const stripMovementsAfter = await movementsOf(api, 'COIL', strip.id);
      expect(
        stripMovementsAfter.length,
        'Asignar un fleje a una OP no debe emitir ningún movimiento de kardex (D-060)',
      ).toBe(stripMovementsBefore.length);
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('2400.000');

      // El fleje deja de ofrecerse: ya está tomado por esta orden.
      const optionsAfter = await getJson<StripOptionDto[]>(
        api,
        `/api/production/strips?productId=${s.product.id}`,
      );
      expect(optionsAfter.some((o) => o.coilId === strip.id)).toBe(false);

      // --- Primer reporte parcial: 500 piezas = 1 000 kg de fleje a S/ 4/kg ---
      const first = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/report`, {
        pieces: 500,
      });
      expect(first.piecesReported).toBe(500);
      const report1 = first.reports[0]!;
      expect(report1).toMatchObject({
        pieces: 500,
        theoreticalKg: '1000.000',
        materialCostPen: '4000.0000',
        unitCostPen: '8.0000',
        status: 'ACTIVE',
      });
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('1400.000');
      const productAfterFirst = await balanceOf(api, 'PRODUCT', s.product.id);
      expect(productAfterFirst).toMatchObject({ qty: '500.000', unit: 'NIU', avgCost: '8.0000' });

      // --- Segundo reporte parcial: 400 piezas = 800 kg ---
      const second = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/report`, {
        pieces: 400,
      });
      expect(second.piecesReported).toBe(900);
      expect(second.consumptions[0]).toMatchObject({
        assignedKg: '2400.000',
        consumedKg: '1800.000',
        remainingKg: '600.000',
      });
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('600.000');

      // --- Cerrar: los 600 kg que quedaron asignados salen como merma de proceso ---
      // 600 de 2 400 kg es un 25 %: por encima del 10 %, cerrar es una baja de inventario
      // y exige motivo como cualquier merma (D-057).
      const sinMotivo = await postExpectingError(api, `/api/production/${opId}/close`, {});
      expect(sinMotivo.status).toBe(400);
      expect(sinMotivo.message).toContain('600.000 kg de merma');
      expect(sinMotivo.message).toContain('motivo');

      const closed = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/close`, {
        reason: 'Sobró material del rollo al terminar la corrida (prueba E2E)',
      });
      expect(closed.status).toBe('CLOSED');
      expect(closed).toMatchObject({
        piecesReported: 900,
        scrapKg: '600.000',
        // 1 000 + 800 + 600 kg × S/ 4 = S/ 9 600, todo el fleje que la OP tomó.
        materialCostPen: '9600.0000',
        // D-056: el hook de mano de obra/overhead queda explícitamente en cero en v1.
        overheadCostPen: '0.0000',
        totalCostPen: '9600.0000',
        // S/ 9 600 / 900 piezas buenas: la merma la absorben las piezas.
        unitCostPen: '10.6667',
      });

      // El fleje queda en cero: nada de lo que la OP tomó quedó colgado.
      const stripBalance = await balanceOf(api, 'COIL', strip.id);
      expect(stripBalance.qty).toBe('0.000');

      // Kardex del fleje: entrada del corte + dos consumos de producción + la merma.
      const stripMovements = live(await movementsOf(api, 'COIL', strip.id));
      const production = stripMovements.filter((m) => m.refType === 'PRODUCTION');
      const scrap = stripMovements.filter((m) => m.refType === 'SCRAP');
      expect(production.map((m) => m.qty)).toEqual(['1000.000', '800.000']);
      expect(scrap.map((m) => m.qty)).toEqual(['600.000']);
      expect(production.every((m) => m.type === 'OUT')).toBe(true);
      expect(scrap[0]?.type).toBe('OUT');

      // El kardex cuadra en valor: lo que salió del fleje es lo que vale el stock de
      // piezas. 2 400 kg × S/ 4 = S/ 9 600 = 900 piezas × S/ 10.6667.
      const productBalance = await balanceOf(api, 'PRODUCT', s.product.id);
      expect(productBalance).toMatchObject({ qty: '900.000', unit: 'NIU', avgCost: '10.6667' });

      // Y el rastro llega hasta la bobina madre: el fleje salió de ella por el corte.
      const stripCoil = await getJson<CoilDto>(api, `/api/coils/${strip.id}`);
      expect(stripCoil.parentCoilId).toBe(s.mother.id);
      const motherMovements = live(await movementsOf(api, 'COIL', s.mother.id));
      expect(motherMovements.some((m) => m.refType === 'CUTTING' && m.type === 'OUT')).toBe(true);

      // --- Y el cierre también se deshace (D-060): reabrir devuelve la merma y el costo ---
      const reopened = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/reopen`, {
        reason: 'Se reabre la corrida en la prueba E2E',
      });
      expect(reopened).toMatchObject({
        status: 'IN_PROGRESS',
        scrapKg: null,
        materialCostPen: null,
        unitCostPen: null,
        piecesReported: 900,
      });
      // La merma vuelve al fleje y el ajuste de costo se deshace: las piezas quedan otra
      // vez al costo con el que entraron.
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('600.000');
      expect(await balanceOf(api, 'PRODUCT', s.product.id)).toMatchObject({
        qty: '900.000',
        avgCost: '8.0000',
      });

      // Desde ahí se revierten los reportes (el último primero) y la OP se puede anular:
      // es exactamente lo que hace `pnpm prod:purge-e2e` para no dejar stock de prueba.
      const activeReports = reopened.reports.filter((r) => r.status === 'ACTIVE');
      for (const r of [...activeReports].reverse()) {
        await postJson<ProductionOrderDto>(api, `/api/production/${opId}/reports/${r.id}/reverse`, {
          reason: 'Limpieza de la prueba E2E',
        });
      }
      expect((await balanceOf(api, 'PRODUCT', s.product.id)).qty).toBe('0.000');
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('2400.000');
      const finished = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/cancel`, {
        reason: 'Cierre de la prueba E2E',
      });
      expect(finished.status).toBe('CANCELLED');
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

  test('revertir un reporte restaura el kardex de las dos puntas y después la OP se puede anular, liberando los flejes', async ({
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
      });
      const reported = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/report`, {
        pieces: 300,
      });
      const report = reported.reports[0]!;
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('1800.000');
      expect((await balanceOf(api, 'PRODUCT', s.product.id)).qty).toBe('300.000');

      // --- Revertir el reporte ---
      const reverted = await postJson<ProductionOrderDto>(
        api,
        `/api/production/${opId}/reports/${report.id}/reverse`,
        { reason: 'Piezas mal contadas en la prueba E2E' },
      );
      expect(reverted.piecesReported).toBe(0);
      const revertedReport = reverted.reports.find((r) => r.id === report.id)!;
      expect(revertedReport.status).toBe('REVERTED');
      expect(revertedReport.revertedAt).not.toBeNull();

      // Kardex restaurado en las dos puntas: el fleje recupera sus kilos y el producto
      // se queda sin piezas.
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('2400.000');
      expect((await balanceOf(api, 'PRODUCT', s.product.id)).qty).toBe('0.000');
      const stripLive = live(await movementsOf(api, 'COIL', strip.id));
      expect(
        stripLive.some((m) => m.refType === 'PRODUCTION'),
        'La reversa debe dejar sin efecto la salida de producción del fleje',
      ).toBe(false);
      // Pero el rastro queda: el kardex es append-only (§3.2), el par sigue ahí.
      const stripAll = await movementsOf(api, 'COIL', strip.id);
      expect(stripAll.filter((m) => m.refType === 'PRODUCTION')).toHaveLength(2);

      // Y la asignación vuelve a estar entera, lista para reportar de nuevo.
      const afterRevert = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      expect(afterRevert.consumptions[0]).toMatchObject({
        assignedKg: '2400.000',
        consumedKg: '0.000',
        remainingKg: '2400.000',
      });

      // --- Sin reportes vivos, la OP se anula y libera el fleje ---
      const cancelled = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/cancel`, {
        reason: 'Corrida abortada en la prueba E2E',
      });
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.consumptions[0]?.releasedAt).not.toBeNull();

      // El fleje vuelve a ofrecerse y a admitir cualquier operación: la merma prueba que
      // el guardrail de D-060 ya no aplica.
      const options = await getJson<StripOptionDto[]>(
        api,
        `/api/production/strips?productId=${s.product.id}`,
      );
      expect(options.some((o) => o.coilId === strip.id)).toBe(true);
      const scrapped = await postJson<CoilDto>(api, `/api/coils/${strip.id}/scrap`, {
        qtyKg: '10',
        reason: 'Merma E2E tras liberar el fleje',
      });
      expect(scrapped.availableKg).toBe('2390.000');
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

  test('guardrail D-060: un fleje asignado a una OP no se puede mermar, ni anular, ni enviar a corte, ni consumir en otra orden', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupScenario(api);
    let opId = '';
    let otherOpId = '';

    try {
      const strip = s.strips[0]!;
      const op = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
      });
      opId = op.id;
      const consumed = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/consume`, {
        coilId: strip.id,
      });
      expect(consumed.status).toBe('IN_PROGRESS');

      // Merma (RF-17)
      const scrap = await postExpectingError(api, `/api/coils/${strip.id}/scrap`, {
        qtyKg: '10',
        reason: 'Intento de merma con el fleje montado (prueba E2E)',
      });
      expect(scrap.status).toBe(400);
      expect(scrap.message).toContain(strip.code);
      expect(scrap.message).toContain(op.code);
      expect(scrap.message).toContain('orden de producción');

      // Anulación de la bobina (RF-21)
      const cancel = await postExpectingError(api, `/api/coils/${strip.id}/cancel`, {
        reason: 'Intento de anular con el fleje montado (prueba E2E)',
      });
      expect(cancel.status).toBe(400);
      expect(cancel.message).toContain(op.code);

      // Partido local (RF-15)
      const split = await postExpectingError(api, `/api/coils/${strip.id}/split`, {
        splitWeightKg: '100',
        kerfLossMm: '0',
        children: [{ widthMm: '580', count: 1 }],
      });
      expect(split.status).toBe(400);
      expect(split.message).toContain(op.code);

      // Cierre del fleje (RF-19)
      const close = await postExpectingError(api, `/api/coils/${strip.id}/status`, {
        status: 'CLOSED',
        reason: 'Intento de cierre con el fleje montado (prueba E2E)',
      });
      expect(close.status).toBe(400);
      expect(close.message).toContain(op.code);

      // Envío a corte tercerizado (RF-40): un fleje nunca se manda a cortar de nuevo.
      const send = await postExpectingError(api, '/api/cutting', {
        supplierId: s.supplier.id,
        coils: [
          {
            coilId: strip.id,
            widthPlanMm: [{ widthMm: '280', stripsCount: 2 }],
            expectedKerfLossMm: '0',
          },
        ],
      });
      expect(send.status).toBe(400);
      expect(send.message).toContain('no flejes');

      // Anulación de la compra de la bobina madre: los flejes heredan su `purchaseId`, así
      // que anularla los cancelaría. Acá la corta primero el movimiento `CUTTING` de la
      // madre (regla de Fase 2b/3); el guardrail de D-060 es la segunda línea, la que
      // aplica cuando el fleje llega a una OP por un camino que no dejó ese rastro.
      const purchaseCancel = await postExpectingError(
        api,
        `/api/purchases/${s.purchaseId}/cancel`,
        {
          reason: 'Intento de anular la compra con el fleje montado (prueba E2E)',
        },
      );
      expect(purchaseCancel.status).toBe(400);

      // Consumo en otra OP del mismo perfil
      const otherOp = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
      });
      otherOpId = otherOp.id;
      const doubleConsume = await postExpectingError(api, `/api/production/${otherOpId}/consume`, {
        coilId: strip.id,
      });
      expect(doubleConsume.status).toBe(400);
      expect(doubleConsume.message).toContain(op.code);

      // Reversa de la recepción de corte (Fase 3b): el fleje montado la bloquea aunque
      // no haya dejado ningún movimiento de kardex.
      const reverseCut = await postExpectingError(
        api,
        `/api/cutting/${s.cuttingOrderId}/coils/${s.mother.id}/reverse`,
        { reason: 'Intento de revertir el corte con el fleje montado (prueba E2E)' },
      );
      expect(reverseCut.status).toBe(400);
      expect(reverseCut.message).toContain(op.code);

      // Nada quedó a medias: el fleje sigue intacto y la OP también.
      const stripAfter = await getJson<CoilDto>(api, `/api/coils/${strip.id}`);
      expect(stripAfter).toMatchObject({ status: 'OPEN', availableKg: '2400.000' });
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          productionOrderIds: [opId, otherOpId].filter(Boolean),
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

  test('la reversa de un reporte se bloquea con 400 si las piezas ya se movieron: el cierre de otra OP del mismo perfil las recosteó', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupScenario(api);
    let firstOpId = '';
    let secondOpId = '';

    try {
      const [stripA, stripB] = s.strips;

      // OP 1 reporta y queda abierta.
      const first = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
      });
      firstOpId = first.id;
      await postJson<ProductionOrderDto>(api, `/api/production/${firstOpId}/consume`, {
        coilId: stripA!.id,
      });
      const reported = await postJson<ProductionOrderDto>(
        api,
        `/api/production/${firstOpId}/report`,
        { pieces: 200 },
      );
      const report = reported.reports[0]!;

      // OP 2 produce el MISMO perfil y cierra: su cierre emite el ajuste de costo que
      // reparte su merma sobre todo el stock de piezas, incluidas las de la OP 1.
      const second = await postJson<ProductionOrderDto>(api, '/api/production', {
        productId: s.product.id,
      });
      secondOpId = second.id;
      await postJson<ProductionOrderDto>(api, `/api/production/${secondOpId}/consume`, {
        coilId: stripB!.id,
      });
      await postJson<ProductionOrderDto>(api, `/api/production/${secondOpId}/report`, {
        pieces: 100,
      });
      const closed = await postJson<ProductionOrderDto>(
        api,
        `/api/production/${secondOpId}/close`,
        { reason: 'Cierre con el resto del fleje como merma (prueba E2E)' },
      );
      expect(closed.status).toBe('CLOSED');
      expect(closed.scrapKg).toBe('2200.000');

      const blocked = await postExpectingError(
        api,
        `/api/production/${firstOpId}/reports/${report.id}/reverse`,
        { reason: 'Intento de revertir con las piezas ya recosteadas (prueba E2E)' },
      );
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain('ya se movieron');
      expect(blocked.message).toContain('PRODUCTION');

      // Nada quedó a medias: el reporte sigue vigente y el stock intacto.
      const stillOpen = await getJson<ProductionOrderDto>(api, `/api/production/${firstOpId}`);
      expect(stillOpen.reports.find((r) => r.id === report.id)?.status).toBe('ACTIVE');
      expect((await balanceOf(api, 'PRODUCT', s.product.id)).qty).toBe('300.000');
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          productionOrderIds: [firstOpId, secondOpId].filter(Boolean),
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

  test('anular una OP se bloquea con 400 mientras tenga reportes vigentes, y se destraba al revertirlos', async ({
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
      });
      const reported = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/report`, {
        pieces: 150,
      });
      const report = reported.reports[0]!;

      const blocked = await postExpectingError(api, `/api/production/${opId}/cancel`, {
        reason: 'Intento de anular con piezas reportadas (prueba E2E)',
      });
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain('150 piezas');
      expect(blocked.message).toContain('revierte esos reportes');

      // Nada quedó a medias: la OP sigue viva con su reporte y su kardex.
      const stillLive = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      expect(stillLive.status).toBe('IN_PROGRESS');
      expect((await balanceOf(api, 'PRODUCT', s.product.id)).qty).toBe('150.000');

      // Revertido el reporte, la anulación pasa y el fleje queda libre.
      await postJson<ProductionOrderDto>(
        api,
        `/api/production/${opId}/reports/${report.id}/reverse`,
        { reason: 'Se revierte para poder anular la OP (prueba E2E)' },
      );
      const cancelled = await postJson<ProductionOrderDto>(api, `/api/production/${opId}/cancel`, {
        reason: 'Corrida abortada en la prueba E2E',
      });
      expect(cancelled.status).toBe('CANCELLED');
      expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('2400.000');
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
