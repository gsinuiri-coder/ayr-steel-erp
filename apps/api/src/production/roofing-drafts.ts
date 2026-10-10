import type { Prisma } from '@prisma/client';
import {
  Decimal,
  mountedKgForReport,
  piecesMeters,
  planExcessMessage,
  roofingPlanGap,
  roofingPlanOverrun,
  roofingPlanProgress,
  toDecimal,
  toFixedString,
  type MountedKgExcess,
  type PieceLike,
  type RoofingReportDraftDto,
} from '@ayr/shared';
import { roofingTheoreticalKg, type CoilGeometry } from './roofing-math';

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
  geometry: CoilGeometry;
}

export interface DraftCheckState {
  orderSeq: number;
  productSku: string;
  /** Largo fijo de una plancha de catálogo (D-083); `null` a medida. */
  fixedLengthMm: string | null;
  planPieces: readonly PieceLike[];
  /** Metros de los reportes vigentes (en un accesorio, sus metros de bobina). */
  reportedMeters: Decimal;
  coils: readonly DraftCoilState[];
  /**
   * cc41 (D-591): la orden es de un **accesorio** (D-343): sus filas llevan metros de bobina y no
   * largos, y su plan son los metros que encargó la línea del pedido (`null` sin pedido: sin tope,
   * igual que su parte). Ausente o `null` en una cobertura.
   */
  accessory?: { orderedMeters: Decimal | null } | null;
}

export interface DraftRowLike {
  coilId: string | undefined;
  pieces: readonly PieceLike[];
  /** cc41 (D-591): metros de bobina de una fila de accesorio; ausente o `null` en coberturas. */
  meters?: string | null;
  /** Kilos declarados de la fila (D-246: si caben en lo montado, la fila se topa ahí). */
  consumedKg?: string | null;
}

export interface DraftRowCheck {
  coil: DraftCoilState;
  meters: Decimal;
  theoreticalKg: Decimal;
  /** Lo que la fila va a sacar de la bobina al ejecutarse (D-246). */
  outKg: Decimal;
  /**
   * D-388/D-389: la fila pasa lo montado más del 1 % del teórico (sin tope); al ejecutarla hace falta
   * la casilla y un motivo. `null` dentro de tolerancia.
   */
  outOfTolerance: MountedKgExcess | null;
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
  const accessory = state.accessory ?? null;
  const usedKg = new Map<string, Decimal>();
  let draftMeters = new Decimal(0);
  const checks: DraftRowCheck[] = [];

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 1;
    const fail = (message: string): DraftCheckResult => ({ ok: false, rowNumber, message });

    const coil = resolveDraftCoil(state.coils, row.coilId);
    if (typeof coil === 'string') return fail(coil);

    // cc41 (D-591): la forma de la fila la decide el producto, con los textos del parte (D-343).
    const rowMeters = row.meters ?? null;
    if (accessory !== null && (rowMeters === null || row.pieces.length > 0)) {
      return fail(
        `${state.productSku} es un accesorio: reporta los metros lineales de bobina que usó, no largos`,
      );
    }
    if (accessory === null && rowMeters !== null) {
      return fail(`${state.productSku} no es un accesorio: detalla los largos que salieron`);
    }
    const pieces = mathPieces(row);

    if (state.fixedLengthMm !== null) {
      const fixed = toDecimal(state.fixedLengthMm).toFixed(2);
      const off = row.pieces.find((p) => toDecimal(p.lengthMm).toFixed(2) !== fixed);
      if (off) {
        return fail(
          `${state.productSku} es una plancha de catálogo de ${toDecimal(fixed).div(1000).toFixed(2)} m: no admite un largo de ${toDecimal(off.lengthMm).div(1000).toFixed(2)} m`,
        );
      }
    }

    // D-146 con el borrador adentro: lo que ya ocupan las filas anteriores cuenta como si
    // estuviera reportado, porque al ejecutar lo va a estar.
    const meters = piecesMeters(pieces);
    // cc38 (D-574): el texto nombra cuánto se pasa lo registrado más el borrador. En un accesorio,
    // contra los metros del pedido, como su parte (cc41).
    if (accessory === null) {
      const progress = roofingPlanProgress(
        state.planPieces,
        state.reportedMeters.plus(draftMeters),
      );
      const overrun = roofingPlanOverrun(progress, meters);
      if (overrun.gt(0)) return fail(planExcessMessage(overrun));
    } else if (accessory.orderedMeters !== null) {
      const { excess } = roofingPlanGap(
        accessory.orderedMeters,
        state.reportedMeters.plus(draftMeters).plus(meters),
      );
      if (excess.gt(0)) return fail(planExcessMessage(excess));
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
      // D-388: el borrador admite la franja autorizable y la marca; la casilla viaja al ejecutar.
      overrideBands: { authorized: true },
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
    checks.push({
      coil,
      meters,
      theoreticalKg,
      outKg: mounted.kg,
      outOfTolerance: mounted.overridden ? mounted.excess : null,
    });
  }

  return { ok: true, rows: checks };
}

/**
 * D-343: los metros de un accesorio entran a la cuenta como **un solo largo de esa longitud**, el
 * mismo vehículo aritmético de su parte (`reportInTx`): kilo teórico y tope de lo montado.
 */
export function mathPieces(row: Pick<DraftRowLike, 'pieces' | 'meters'>): PieceLike[] {
  const meters = row.meters ?? null;
  if (meters === null) return [...row.pieces];
  return [{ lengthMm: toDecimal(meters).times(1000).toFixed(2), qty: 1 }];
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
  outOfTolerance: MountedKgExcess | null = null,
): RoofingReportDraftDto {
  const pieces = draft.pieces.map((p) => ({
    lineNumber: p.lineNumber,
    lengthMm: p.lengthMm.toFixed(2),
    qty: p.qty,
  }));
  const math = mathPieces(draftRowLike(draft));
  return {
    id: draft.id,
    rowNumber: index + 1,
    coilId: draft.coilId,
    coilCode: draft.coil.code,
    pieces,
    meters: piecesMeters(math).toFixed(3),
    piecesCount: draft.piecesCount ?? null,
    theoreticalKg: roofingTheoreticalKg(
      {
        widthMm: draft.coil.widthMm.toFixed(2),
        thicknessMm: draft.coil.thicknessMm.toFixed(2),
        densityFactor: draft.coil.finish.densityFactor.toFixed(4),
      },
      math,
    ).toFixed(3),
    consumedKg: draft.consumedKg === null ? null : draft.consumedKg.toFixed(3),
    notes: draft.notes,
    createdAt: draft.createdAt.toISOString(),
    outOfTolerance,
  };
}

/** Una fila guardada del borrador, en la forma que valida `checkDraftRows`. */
export function draftRowLike(draft: DraftRow): DraftRowLike {
  return {
    coilId: draft.coilId,
    pieces: draft.pieces.map((p) => ({ lengthMm: p.lengthMm.toFixed(2), qty: p.qty })),
    // cc41 (D-591): solo una fila de accesorio lleva metros; la de coberturas queda como antes.
    ...((draft.meters ?? null) === null ? {} : { meters: draft.meters?.toFixed(3) }),
    consumedKg: draft.consumedKg === null ? null : draft.consumedKg.toFixed(3),
  };
}

/** Las bobinas montadas de la orden, como las lee la validación del borrador. */
export function draftCoilStates(
  consumptions: readonly {
    coilId: string;
    assignedKg: Prisma.Decimal;
    consumedKg: Prisma.Decimal;
    coil: {
      code: string;
      widthMm: Prisma.Decimal;
      thicknessMm: Prisma.Decimal;
      finish: { densityFactor: Prisma.Decimal };
    };
  }[],
): DraftCoilState[] {
  return consumptions.map((c) => ({
    coilId: c.coilId,
    coilCode: c.coil.code,
    remainingKg: toDecimal(c.assignedKg.toString()).minus(toDecimal(c.consumedKg.toString())),
    geometry: {
      widthMm: c.coil.widthMm.toFixed(2),
      thicknessMm: c.coil.thicknessMm.toFixed(2),
      densityFactor: c.coil.finish.densityFactor.toFixed(4),
    },
  }));
}

/**
 * D-388: las filas del borrador con su marca `outOfTolerance`, calculada al leer contra el estado
 * de ahora (la misma validación que al ingresar y al ejecutar). Si el borrador ya no valida —el
 * estado cambió por debajo—, ninguna fila se marca: el error lo da quien lo ejecute.
 */
export function draftDtos(
  state: DraftCheckState,
  drafts: readonly DraftRow[],
): RoofingReportDraftDto[] {
  const check = drafts.length === 0 ? null : checkDraftRows(state, drafts.map(draftRowLike));
  return drafts.map((draft, index) =>
    toDraftDto(draft, index, check?.ok ? (check.rows[index]?.outOfTolerance ?? null) : null),
  );
}
