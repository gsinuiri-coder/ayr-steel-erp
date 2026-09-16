import { AUDIT_SOURCES, type AuditSource } from '@ayr/shared';

/**
 * Cursor estable (occurredAt, fuente, id) sobre la unión de 4 fuentes heterogéneas
 * (D-218/RF-S2/M3). El orden entre fuentes con el mismo `occurredAt` no tiene ningún
 * significado de negocio — es puramente un desempate determinístico, fijo por el índice de
 * `AUDIT_SOURCES` — pero tiene que ser el **mismo** en el `ORDER BY` de cada fuente, en el
 * merge en memoria y en la condición de "después del cursor" de la página siguiente, o una
 * fila puede aparecer dos veces o perderse en el borde exacto de una página.
 */
export interface AuditCursor {
  occurredAt: string;
  source: AuditSource;
  id: string;
}

export function sourceRank(source: AuditSource): number {
  const rank = AUDIT_SOURCES.indexOf(source);
  if (rank === -1) throw new Error(`Fuente de auditoría desconocida: ${source}`);
  return rank;
}

export function encodeCursor(c: AuditCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): AuditCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { occurredAt?: unknown }).occurredAt !== 'string' ||
      typeof (parsed as { source?: unknown }).source !== 'string' ||
      typeof (parsed as { id?: unknown }).id !== 'string' ||
      !AUDIT_SOURCES.includes((parsed as { source: AuditSource }).source) ||
      // `audit_log.id` es BigInt (`audit-query.service.ts` lo pasa por `BigInt(...)` para el
      // `where` de la página siguiente): un cursor crafteado a mano con un id no numérico ahí
      // revienta `BigInt(...)` con un error sin capturar en vez de este 400 controlado.
      ((parsed as { source: AuditSource }).source === 'audit_log' &&
        !/^\d+$/.test((parsed as { id: string }).id))
    ) {
      throw new Error('forma inválida');
    }
    return parsed as AuditCursor;
  } catch {
    throw new Error('Cursor de auditoría inválido');
  }
}

export type CursorBoundary =
  | { mode: 'lt'; occurredAt: string }
  | { mode: 'lte'; occurredAt: string }
  | { mode: 'same-source'; occurredAt: string; id: string };

/**
 * La condición de "esta fila va después del cursor", para una fuente de rank `myRank`
 * (constante para cada adaptador). `null` sin cursor (primera página: todo vale).
 *
 * - Rank más alto que el del cursor: una fila con el mismo `occurredAt` **sí** va después
 *   (el desempate la pone más tarde) → `occurredAt <= cursor` (borde inclusive, `lte`).
 * - Rank más bajo: una fila con el mismo `occurredAt` **ya** se mostró → `occurredAt < cursor` (`lt`).
 * - Mismo rank (la propia fuente del cursor): además del `occurredAt` estricto, un empate
 *   exacto se desempata por `id` (compara como texto: alcanza con ser estable, no con tener
 *   un orden con sentido de negocio).
 */
export function afterCursorWhere(
  myRank: number,
  cursor: AuditCursor | null,
): CursorBoundary | null {
  if (cursor === null) return null;
  const cursorRank = sourceRank(cursor.source);
  if (myRank > cursorRank) return { mode: 'lte', occurredAt: cursor.occurredAt };
  if (myRank < cursorRank) return { mode: 'lt', occurredAt: cursor.occurredAt };
  return { mode: 'same-source', occurredAt: cursor.occurredAt, id: cursor.id };
}
