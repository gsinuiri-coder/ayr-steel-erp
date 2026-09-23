import type { Prisma } from '@prisma/client';
import {
  Decimal,
  mountedKgForReport,
  piecesMeters,
  productionOrderCode,
  roofingPlanOverrun,
  roofingPlanProgress,
  toDecimal,
  toFixedString,
  type PieceLike,
  type RoofingReportDraftDto,
} from '@ayr/shared';
import { accessoryPiecesFromPasses, roofingTheoreticalKg, type CoilGeometry } from './roofing-math';

/**
 * D-191 — la validación del borrador de reportes, **pura**.
 *
 * Es la misma para las dos puntas del borrador y por eso vive sola: al **ingresar** una fila
 * (feedback inmediato, contra lo reportado más todo lo que el borrador ya ocupa) y al
 * **ejecutar** (revalidación completa dentro de la transacción, porque entre medio pudieron
 * cambiar el plan, las bobinas montadas o los reportes). Con dos copias, la del ingreso
 * dejaría pasar lo que la del commit rechaza — que es exactamente la clase de divergencia que
 * D-146 vino a cerrar del lado del reporte.
 *
 * Recorre las filas **en orden y acumulando**: la fila 3 se mide contra el plan que dejan las
 * filas 1 y 2, y contra los kilos de su bobina que esas filas ya tomaron. El primer error
 * corta y nombra su fila.
 */

export interface DraftCoilState {
  coilId: string;
  coilCode: string;
  /** Kilos montados sin rolar: `assignedKg − consumedKg` de la asignación viva. */
  remainingKg: Decimal;
  /**
   * La geometría con la que se cuenta el material de **esta** bobina. En un accesorio ya
   * viene con el ancho efectivo (`ancho ÷ N`, D-248): la arma quien conoce el producto, y
   * acá se usa igual que siempre.
   */
  geometry: CoilGeometry;
  /**
   * D-248: piezas por pasada de esta bobina, `null` fuera de un accesorio.
   *
   * El borrador guarda lo que planta **tipeó** —pasadas—, no las piezas: ejecutar llama a
   * `reportInTx`, que es quien convierte (D-c). Si el borrador guardara piezas, ejecutarlo
   * multiplicaría una segunda vez. Por eso la previsualización convierte acá y la fila
   * persistida se queda en pasadas.
   */
  piecesPerPass: number | null;
}

export interface DraftCheckState {
  orderSeq: number;
  productSku: string;
  /** Largo fijo de una plancha de catálogo (D-083); `null` a medida. */
  fixedLengthMm: string | null;
  planPieces: readonly PieceLike[];
  /** Metros de los reportes vigentes. */
  reportedMeters: Decimal;
  coils: readonly DraftCoilState[];
}

export interface DraftRowLike {
  coilId: string | undefined;
  pieces: readonly PieceLike[];
  /** Kilos declarados de la fila (D-246: si caben en lo montado, la fila se topa ahí). */
  consumedKg?: string | null;
}

export interface DraftRowCheck {
  coil: DraftCoilState;
  meters: Decimal;
  theoreticalKg: Decimal;
  /** Lo que la fila va a sacar de la bobina al ejecutarse (D-246). */
  outKg: Decimal;
}

export type DraftCheckResult =
  { ok: true; rows: DraftRowCheck[] } | { ok: false; rowNumber: number; message: string };

/** La bobina de la fila: la indicada, o la única montada. */
export function resolveDraftCoil(
  coils: readonly DraftCoilState[],
  coilId: string | undefined,
): DraftCoilState | string {
  const [only, ...rest] = coils;
  if (only === undefined) {
    return 'La orden no tiene ninguna bobina montada: monta el material antes de reportar';
  }
  if (coilId === undefined) {
    return rest.length === 0
      ? only
      : 'La orden tiene varias bobinas montadas: indica de cuál salieron estas planchas';
  }
  return coils.find((c) => c.coilId === coilId) ?? 'Esa bobina no está montada en la orden';
}

export function checkDraftRows(
  state: DraftCheckState,
  rows: readonly DraftRowLike[],
): DraftCheckResult {
  const code = productionOrderCode(state.orderSeq);
  const usedKg = new Map<string, Decimal>();
  let draftMeters = new Decimal(0);
  const checks: DraftRowCheck[] = [];

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 1;
    const fail = (message: string): DraftCheckResult => ({ ok: false, rowNumber, message });

    const coil = resolveDraftCoil(state.coils, row.coilId);
    if (typeof coil === 'string') return fail(coil);

    if (state.fixedLengthMm !== null) {
      const fixed = toDecimal(state.fixedLengthMm).toFixed(2);
      const off = row.pieces.find((p) => toDecimal(p.lengthMm).toFixed(2) !== fixed);
      if (off) {
        return fail(
          `${state.productSku} es una plancha de catálogo de ${toDecimal(fixed).div(1000).toFixed(2)} m: no admite un largo de ${toDecimal(off.lengthMm).div(1000).toFixed(2)} m`,
        );
      }
    }

    // D-248: la fila del borrador está en pasadas; el plan, el kardex y la bobina hablan de
    // piezas. Se convierte una vez, acá, y de este punto en adelante la validación es la
    // misma que la de una cobertura a medida — que es la razón de que el borrador y el
    // reporte no puedan divergir.
    const pieces =
      coil.piecesPerPass === null
        ? row.pieces
        : accessoryPiecesFromPasses(
            row.pieces.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty })),
            coil.piecesPerPass,
          );

    // D-146 con el borrador adentro: lo que ya ocupan las filas anteriores cuenta como si
    // estuviera reportado, porque al ejecutar lo va a estar.
    const meters = piecesMeters(pieces);
    const progress = roofingPlanProgress(state.planPieces, state.reportedMeters.plus(draftMeters));
    if (roofingPlanOverrun(progress, meters).gt(0)) {
      return fail(
        `${code} tiene un plan de ${progress.planMeters.toFixed(3)} m; entre lo reportado ` +
          `(${state.reportedMeters.toFixed(3)} m) y el borrador (${draftMeters.toFixed(3)} m) ` +
          (progress.remainingMeters.isZero()
            ? 'el plan ya está cubierto y esta fila no entra. '
            : `quedan ${progress.remainingMeters.toFixed(3)} m y esta fila suma ${meters.toFixed(3)} m. `) +
          'Si de verdad hay que producir más, ajusta primero el plan de corte (RF-31).',
      );
    }

    const theoreticalKg = roofingTheoreticalKg(coil.geometry, pieces);
    const alreadyKg = usedKg.get(coil.coilId) ?? new Decimal(0);
    const leftKg = coil.remainingKg.minus(alreadyKg);
    // D-246: la misma regla que el reporte del API, fila por fila. Una fila topada deja la
    // bobina en cero para las que siguen: el borrador acumula lo que **sale**, no el teórico.
    const mounted = mountedKgForReport({
      label: coil.coilCode,
      theoreticalKg,
      availableKg: leftKg,
      declaredKg: row.consumedKg ?? null,
    });
    if (!mounted.ok) {
      return fail(
        alreadyKg.gt(0)
          ? `${mounted.message} (el borrador ya ocupa ${toFixedString(alreadyKg, 'KG')} kg de ${toFixedString(coil.remainingKg, 'KG')} kg montados sin rolar)`
          : mounted.message,
      );
    }

    usedKg.set(coil.coilId, alreadyKg.plus(mounted.kg));
    draftMeters = draftMeters.plus(meters);
    checks.push({ coil, meters, theoreticalKg, outKg: mounted.kg });
  }

  return { ok: true, rows: checks };
}

/** Lo que se lee de un borrador para validarlo y para devolverlo. */
export const DRAFT_INCLUDE = {
  pieces: { orderBy: { lineNumber: 'asc' } },
  coil: {
    select: {
      code: true,
      widthMm: true,
      thicknessMm: true,
      finish: { select: { densityFactor: true } },
    },
  },
} satisfies Prisma.ProductionReportDraftInclude;

export type DraftRow = Prisma.ProductionReportDraftGetPayload<{ include: typeof DRAFT_INCLUDE }>;

export function toDraftDto(
  draft: DraftRow,
  index: number,
  /**
   * D-248: la conversión del accesorio contra **la bobina de esta fila**, o `null` fuera de
   * un accesorio. Viaja como parámetro y no se deduce del producto acá porque `N` depende
   * del rollo, y dos filas del mismo borrador pueden salir de rollos de anchos distintos.
   */
  accessory: { piecesPerPass: number; effectiveWidthMm: string } | null = null,
): RoofingReportDraftDto {
  // Lo que planta tipeó: pasadas en un accesorio, planchas en el resto.
  const typed = draft.pieces.map((p) => ({
    lineNumber: p.lineNumber,
    lengthMm: p.lengthMm.toFixed(2),
    qty: p.qty,
  }));
  // Lo que va a salir de la roladora, que es lo que el plan y el kardex miden.
  const pieces =
    accessory === null ? typed : accessoryPiecesFromPasses(typed, accessory.piecesPerPass);
  return {
    id: draft.id,
    rowNumber: index + 1,
    coilId: draft.coilId,
    coilCode: draft.coil.code,
    pieces: typed,
    piecesPerPass: accessory?.piecesPerPass ?? null,
    meters: piecesMeters(pieces).toFixed(3),
    theoreticalKg: roofingTheoreticalKg(
      {
        widthMm: accessory?.effectiveWidthMm ?? draft.coil.widthMm.toFixed(2),
        thicknessMm: draft.coil.thicknessMm.toFixed(2),
        densityFactor: draft.coil.finish.densityFactor.toFixed(4),
      },
      pieces,
    ).toFixed(3),
    consumedKg: draft.consumedKg === null ? null : draft.consumedKg.toFixed(3),
    notes: draft.notes,
    createdAt: draft.createdAt.toISOString(),
  };
}
