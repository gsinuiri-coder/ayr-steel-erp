import {
  MAX_PIECE_LENGTH_MM,
  MAX_PIECE_LINES,
  MAX_PIECE_QTY,
  MIN_PIECE_LENGTH_MM,
  toDecimal,
  type RoofingPieceDto,
} from '@ayr/shared';

/**
 * El editor de largos, en un solo sitio (D-083).
 *
 * Lo usan el formulario de cotización y la terminal de planta, que capturan exactamente lo
 * mismo con dos formas distintas. Estaba duplicado y las dos copias ya habían empezado a
 * divergir: una convertía metros a milímetros con `Decimal` y la otra con `number`, y
 * ninguna comprobaba las cotas que el API sí valida, así que un largo de 25 m dejaba el
 * botón habilitado y se comía un 400.
 *
 * Devuelve **el motivo** cuando no valida, no solo `null`: "falta la cantidad", "ese largo
 * está repetido" y "ese largo no existe" son tres errores distintos y el operario necesita
 * saber cuál cometió.
 */

/** Una fila del editor: metros a la vista, milímetros hacia el API. */
export interface PieceRow {
  lengthM: string;
  qty: string;
}

export const EMPTY_PIECE_ROW: PieceRow = { lengthM: '', qty: '' };

export type PieceParse = { ok: true; pieces: RoofingPieceDto[] } | { ok: false; reason: string };

/** Metros → milímetros con la escala de mm (D-003): la UI habla en metros, el API en mm. */
export function metersToMm(lengthM: string): string {
  return toDecimal(lengthM).times(1000).toFixed(2);
}

/** Milímetros → metros, con los tres decimales que la escala de mm admite sin perder nada. */
export function mmToMeters(lengthMm: string): string {
  return toDecimal(lengthMm).div(1000).toFixed(3);
}

const MIN_M = MIN_PIECE_LENGTH_MM / 1000;
const MAX_M = MAX_PIECE_LENGTH_MM / 1000;

export function parsePieceRows(rows: readonly PieceRow[]): PieceParse {
  const filled = rows.filter((r) => r.lengthM.trim() !== '' || r.qty.trim() !== '');
  if (filled.length === 0) {
    return { ok: false, reason: 'Escribe al menos un largo con su cantidad.' };
  }
  if (filled.length > MAX_PIECE_LINES) {
    return { ok: false, reason: `Como máximo ${String(MAX_PIECE_LINES)} largos distintos.` };
  }

  const pieces: RoofingPieceDto[] = [];
  const seen = new Set<string>();
  for (const [i, row] of filled.entries()) {
    const at = `Fila ${String(i + 1)}`;
    const lengthM = row.lengthM.trim();
    const qty = row.qty.trim();

    if (!/^\d+(\.\d{1,3})?$/.test(lengthM)) {
      return { ok: false, reason: `${at}: el largo va en metros, con hasta tres decimales.` };
    }
    const meters = toDecimal(lengthM);
    if (meters.lt(MIN_M) || meters.gt(MAX_M)) {
      return {
        ok: false,
        reason: `${at}: el largo tiene que estar entre ${String(MIN_M)} y ${String(MAX_M)} metros.`,
      };
    }
    if (!/^\d+$/.test(qty) || Number(qty) < 1) {
      return { ok: false, reason: `${at}: la cantidad de planchas es un entero mayor a cero.` };
    }
    if (Number(qty) > MAX_PIECE_QTY) {
      return {
        ok: false,
        reason: `${at}: como máximo ${String(MAX_PIECE_QTY)} planchas por largo.`,
      };
    }

    const lengthMm = metersToMm(lengthM);
    if (seen.has(lengthMm)) {
      return { ok: false, reason: `${at}: ese largo ya está en la lista; súmalo a esa cantidad.` };
    }
    seen.add(lengthMm);
    pieces.push({ lineNumber: i + 1, lengthMm, qty: Number(qty) });
  }
  return { ok: true, pieces };
}
