import {
  piecesMeters,
  toDecimal,
  type RoofingPieceDto,
  type SalesOrderItemQtyPreviewDto,
} from '@ayr/shared';
import { mmToMeters, mmToMetersShort, parsePieceRows } from '@/lib/pieces';

/**
 * cc45 (D-603): el estado del diálogo «Cambiar cantidad», sin React. El API es el que decide (la
 * vista previa corre la misma acción); esto arma lo que se le manda y dice antes de preguntar lo
 * que ya se sabe que no pasa (un largo por debajo de lo registrado).
 */

/** Una fila de la tabla por largo: un largo del pedido o registrado, o uno nuevo («+ Otro largo»). */
export interface QtyLengthRow {
  key: string;
  /** El largo, en mm, de una fila que ya existía; `null` en una fila nueva. */
  lengthMm: string | null;
  /** El largo que se escribe en una fila nueva, en metros. */
  lengthM: string;
  ordered: number;
  registered: number;
  /** Planchas nuevas, como se escriben. */
  next: string;
}

export function initialRows(preview: SalesOrderItemQtyPreviewDto): QtyLengthRow[] {
  return preview.rows.map((r) => ({
    key: r.lengthMm,
    lengthMm: r.lengthMm,
    lengthM: mmToMetersShort(r.lengthMm),
    ordered: r.ordered,
    registered: r.registered,
    next: String(r.ordered),
  }));
}

/** «Bajar a lo registrado»: cada largo en lo registrado; un largo nuevo, en cero. */
export function lowerRowsToRegistered(rows: readonly QtyLengthRow[]): QtyLengthRow[] {
  return rows.map((r) => ({ ...r, next: String(r.registered) }));
}

let nextKey = 0;
/** «+ Otro largo». */
export function addedRow(): QtyLengthRow {
  nextKey += 1;
  return {
    key: `nuevo-${String(nextKey)}`,
    lengthMm: null,
    lengthM: '',
    ordered: 0,
    registered: 0,
    next: '',
  };
}

/** Los metros de una fila, para la columna «Metros»; `null` si todavía no se leen. */
export function rowMeters(row: QtyLengthRow): string | null {
  if (!/^\d+$/.test(row.next.trim())) return null;
  let mm: string;
  if (row.lengthMm !== null) mm = row.lengthMm;
  else if (/^\d+(\.\d{1,3})?$/.test(row.lengthM.trim())) {
    mm = toDecimal(row.lengthM.trim()).times(1000).toFixed(2);
  } else return null;
  return piecesMeters([{ lengthMm: mm, qty: Number(row.next) }]).toFixed(3);
}

export type QtyDraft =
  { ok: true; qty: string; pieces?: RoofingPieceDto[] } | { ok: false; reason: string };

/** Lo que se le manda al API desde la tabla por largo (a medida). */
export function draftFromRows(rows: readonly QtyLengthRow[]): QtyDraft {
  for (const r of rows) {
    if (r.next.trim() !== '' && !/^\d+$/.test(r.next.trim())) {
      return { ok: false, reason: 'Las planchas son un número entero.' };
    }
    const next = r.next.trim() === '' ? 0 : Number(r.next);
    if (next < r.registered) {
      return {
        ok: false,
        reason: `El largo ${mmToMetersShort(r.lengthMm ?? '0')} m no puede bajar de ${String(r.registered)} planchas: ya están registradas.`,
      };
    }
  }
  const filled = rows.filter((r) => r.next.trim() !== '' && Number(r.next) > 0);
  if (filled.length === 0) return { ok: false, reason: 'La línea no puede quedar sin planchas.' };
  const parsed = parsePieceRows(
    filled.map((r) => ({
      lengthM: r.lengthMm === null ? r.lengthM.trim() : mmToMeters(r.lengthMm),
      qty: r.next.trim(),
    })),
  );
  if (!parsed.ok) return parsed;
  return { ok: true, qty: piecesMeters(parsed.pieces).toFixed(3), pieces: parsed.pieces };
}

/** Lo que se le manda al API desde la fila única (plancha de catálogo, accesorio o stock). */
export function draftFromSingle(
  value: string,
  preview: Pick<SalesOrderItemQtyPreviewDto, 'kind' | 'minQty' | 'unit'>,
): QtyDraft {
  const text = value.trim();
  const whole = preview.kind === 'UNITS';
  if (whole ? !/^\d+$/.test(text) : !/^\d+(\.\d{1,3})?$/.test(text)) {
    return {
      ok: false,
      reason: whole
        ? 'Las planchas son un número entero.'
        : 'Escribe la cantidad con hasta 3 decimales.',
    };
  }
  const qty = toDecimal(text);
  if (qty.lte(0)) return { ok: false, reason: 'La cantidad debe ser mayor a cero.' };
  if (qty.lt(preview.minQty)) {
    return {
      ok: false,
      reason: `No puede bajar de ${toDecimal(preview.minQty).toFixed(whole ? 0 : 3)}: ya está registrado o despachado.`,
    };
  }
  return { ok: true, qty: qty.toFixed(3) };
}

/** Si lo que se arma es lo mismo que la línea ya tiene: «Guardar el cambio» queda apagado. */
export function sameAsCurrent(draft: QtyDraft, preview: SalesOrderItemQtyPreviewDto): boolean {
  if (!draft.ok) return false;
  if (!toDecimal(draft.qty).equals(toDecimal(preview.qty))) return false;
  if (draft.pieces === undefined) return true;
  const now = new Map(
    preview.rows.filter((r) => r.ordered > 0).map((r) => [r.lengthMm, r.ordered]),
  );
  return (
    draft.pieces.length === now.size &&
    draft.pieces.every((p) => now.get(toDecimal(p.lengthMm).toFixed(2)) === p.qty)
  );
}

/** «Diferencia»: `+ S/ 333.00` o `− S/ 643.80`, entre dos totales con IGV. */
export function totalDifference(before: string, after: string): { sign: '+' | '−'; abs: string } {
  const diff = toDecimal(after).minus(toDecimal(before));
  return { sign: diff.isNegative() ? '−' : '+', abs: diff.abs().toFixed(2) };
}
