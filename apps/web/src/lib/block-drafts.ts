import {
  piecesMeters,
  toDecimal,
  type RoofingPieceDto,
  type RoofingReportDraftDto,
} from '@ayr/shared';
import { parsePieceRows, type PieceRow } from './pieces';
import { coilOfRowError, withoutRowPrefix } from './production-blocks';

/**
 * cc35 (ESPEC §1): **lo que se escribe en un bloque se guarda solo en el borrador de la orden**
 * (D-191). Esta es la parte pura de ese guardado —qué se manda, en qué orden y a qué bloque va un
 * error—; el hook de la pantalla (`use-block-drafts.tsx`) solo la cablea con React.
 *
 * - `POST` si la bobina no tiene fila, `PUT` si ya la tiene (y `DELETE` de las de más, de un
 *   borrador viejo con dos filas de la misma bobina), `DELETE` si el bloque quedó vacío.
 * - La clave de idempotencia de un alta va atada al contenido (D-182).
 */

export interface BlockEdit {
  rows: PieceRow[];
  consumedKg: string;
}

export type BlockPayload =
  | { ok: true; pieces: RoofingPieceDto[]; consumedKg: string | null; empty: boolean }
  | { ok: false; reason: string };

/** El contenido de un bloque listo para el API, o el motivo por el que todavía no lo está. */
export function blockPayload(edit: BlockEdit): BlockPayload {
  const filled = edit.rows.filter((r) => r.lengthM.trim() !== '' || r.qty.trim() !== '');
  const kg = edit.consumedKg.trim();
  if (filled.length === 0) {
    return kg === ''
      ? { ok: true, pieces: [], consumedKg: null, empty: true }
      : { ok: false, reason: 'Escribe los cortes de esta bobina antes de sus kilos.' };
  }
  const parsed = parsePieceRows(filled);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (kg !== '' && (!/^\d+(\.\d{1,3})?$/.test(kg) || toDecimal(kg).lte(0))) {
    return { ok: false, reason: 'Los kilos van con hasta tres decimales y mayores a cero.' };
  }
  return {
    ok: true,
    pieces: parsed.pieces,
    consumedKg: kg === '' ? null : toDecimal(kg).toFixed(3),
    empty: false,
  };
}

/** Metros de lo que tiene escrito un bloque (cero si todavía no se puede contar). */
export function editMeters(edit: BlockEdit | undefined): string {
  if (edit === undefined) return '0';
  const payload = blockPayload(edit);
  return payload.ok ? piecesMeters(payload.pieces).toFixed(3) : '0';
}

/** Lo que hace falta para hablar con el API (inyectado: en las pruebas es una función falsa). */
export type DraftCall = (
  path: string,
  init: { method: 'POST' | 'PUT' | 'DELETE'; body?: unknown },
) => Promise<RoofingReportDraftDto[]>;

/**
 * Guarda un bloque y devuelve el borrador que quedó (`null` si no hubo nada que mandar). `keyFor`
 * da la clave de idempotencia de un alta para ese contenido; `onSent` avisa que el alta respondió
 * (la clave se olvida).
 */
export async function saveBlockDraft(input: {
  orderId: string;
  coilId: string;
  payload: Extract<BlockPayload, { ok: true }>;
  existing: readonly RoofingReportDraftDto[];
  call: DraftCall;
  keyFor: (fingerprint: string) => string;
  onSent?: (fingerprint: string) => void;
}): Promise<RoofingReportDraftDto[] | null> {
  const { orderId, coilId, payload, existing, call } = input;
  const base = `/production/roofing/${orderId}/drafts`;
  let list: RoofingReportDraftDto[] | null = null;
  if (payload.empty) {
    for (const d of existing) list = await call(`${base}/${d.id}`, { method: 'DELETE' });
    return list;
  }
  const body = {
    coilId,
    pieces: payload.pieces.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty })),
    ...(payload.consumedKg === null ? {} : { consumedKg: payload.consumedKg }),
  };
  const [first, ...rest] = existing;
  for (const d of rest) list = await call(`${base}/${d.id}`, { method: 'DELETE' });
  if (first !== undefined) {
    return call(`${base}/${first.id}`, { method: 'PUT', body });
  }
  const fingerprint = `${coilId}:${JSON.stringify(body)}`;
  list = await call(base, {
    method: 'POST',
    body: { ...body, idempotencyKey: input.keyFor(fingerprint) },
  });
  input.onSent?.(fingerprint);
  return list;
}

/**
 * En qué orden guardar los bloques pendientes: **primero los que bajan** de metros, porque el tope
 * del plan (D-146) mide todo el borrador y una subida antes que su bajada se rechazaría.
 */
export function flushOrder(
  coilIds: readonly string[],
  edits: Readonly<Record<string, BlockEdit>>,
  saved: readonly RoofingReportDraftDto[],
): string[] {
  const growth = (coilId: string) =>
    toDecimal(editMeters(edits[coilId])).minus(
      piecesMeters(saved.filter((d) => d.coilId === coilId).flatMap((d) => d.pieces)),
    );
  return coilIds
    .filter((coilId) => edits[coilId] !== undefined)
    .sort((a, b) => growth(a).comparedTo(growth(b)));
}

/**
 * A qué bloque va el rechazo de guardar `coilId`: si el mensaje nombra otra fila («Fila N: …»,
 * el estado cambió por debajo), al de esa fila; si no, al propio. Sin el «Fila N:».
 */
export function saveErrorTarget(
  message: string,
  coilId: string,
  drafts: readonly { rowNumber: number; coilId: string }[],
): { coilId: string; message: string } {
  const other = coilOfRowError(message, drafts);
  return { coilId: other ?? coilId, message: withoutRowPrefix(message) };
}
