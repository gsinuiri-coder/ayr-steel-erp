import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { atCostReasonText, toDecimal } from '@ayr/shared';
import type { AuditEntry } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import type { SalesItemInput } from '@ayr/shared';
import type { ResolvedSalesLine } from './sales-lines';

/**
 * cc51 (D-641): vender a costo. Funciones puras que usa la cotización (alta, edición y duplicado):
 * quién puede marcar una línea y qué queda en la auditoría. El piso a costo en sí lo comprueba
 * `assertPriceFloor`, que no conoce el rol.
 */

/** Una línea a costo que la cotización ya tenía guardada. */
export interface StoredAtCostLine {
  productId: string;
  /** En una venta de bobina entera, la bobina (la línea de entrada no trae producto). */
  reserveItemId?: string;
  lineNumber?: number;
  qty: { toString(): string };
  unitPricePen: { toString(): string };
  valuePerMeterPen: { toString(): string } | null;
  atCostReason: string | null;
  atCostNote: string | null;
}

type AtCostLine = Pick<
  ResolvedSalesLine,
  'productId' | 'qty' | 'unitPricePen' | 'valuePerMeterPen' | 'atCostReason' | 'atCostNote'
>;

const sameDecimal = (a: { toString(): string } | null, b: { toString(): string } | null) =>
  a === null || b === null ? a === b : toDecimal(a.toString()).equals(toDecimal(b.toString()));

/** La misma línea a costo: mismo producto, cantidad, precio y motivo. */
function sameAtCostLine(line: AtCostLine, stored: StoredAtCostLine): boolean {
  return (
    Boolean(stored.atCostReason) &&
    line.productId === stored.productId &&
    sameDecimal(line.qty, stored.qty) &&
    sameDecimal(line.unitPricePen, stored.unitPricePen) &&
    sameDecimal(line.valuePerMeterPen, stored.valuePerMeterPen) &&
    line.atCostReason === stored.atCostReason &&
    (line.atCostNote ?? null) === (stored.atCostNote ?? null)
  );
}

/**
 * Las líneas a costo **nuevas o cambiadas** respecto de lo guardado. Cada línea guardada empareja
 * una sola vez, para que duplicar una línea a costo no la haga pasar por «igual».
 */
export function changedAtCostLines<T extends AtCostLine>(
  lines: readonly T[],
  stored: readonly StoredAtCostLine[],
): T[] {
  const unused = [...stored];
  return lines.filter((line) => {
    if (!line.atCostReason) return false;
    const match = unused.findIndex((s) => sameAtCostLine(line, s));
    if (match === -1) return true;
    unused.splice(match, 1);
    return false;
  });
}

const FORBIDDEN =
  'Solo un administrador puede vender a costo. Una línea que ya estaba a costo puede quedar igual, pero no cambiarse.';

/**
 * Antes de resolver las líneas (revisión de cc51, P1): otro rol que no sea ADMINISTRADOR solo
 * puede mandar la marca en una línea que ya la tenía guardada (mismo producto o bobina y mismo
 * motivo). Si no, 403 **sin pasar por el piso**: el rechazo del piso a costo diría el costo, que
 * un VENDEDOR no ve. Que la línea quede igual en precio y cantidad lo comprueba después
 * `assertAtCostActor`.
 */
export function assertAtCostRequest(
  actor: Pick<RequestUser, 'role'>,
  items: readonly SalesItemInput[],
  stored: readonly StoredAtCostLine[],
): void {
  if (actor.role === Role.ADMINISTRADOR) return;
  const unused = stored.filter((s) => Boolean(s.atCostReason));
  for (const item of items) {
    if (item.atCost === undefined) continue;
    const match = unused.findIndex(
      (s) =>
        (item.saleCoilId !== undefined
          ? s.reserveItemId === item.saleCoilId
          : s.productId === item.productId) &&
        s.atCostReason === item.atCost?.reason &&
        (s.atCostNote ?? null) === (item.atCost.note ?? null),
    );
    if (match === -1) throw new ForbiddenException(FORBIDDEN);
    unused.splice(match, 1);
  }
}

/**
 * Solo un ADMINISTRADOR marca una línea a costo. Otro rol puede guardar una cotización que ya la
 * tenía siempre que esa línea quede igual (producto, cantidad, precio y motivo).
 */
export function assertAtCostActor(
  actor: Pick<RequestUser, 'role'>,
  lines: readonly AtCostLine[],
  stored: readonly StoredAtCostLine[],
): void {
  if (actor.role === Role.ADMINISTRADOR) return;
  if (changedAtCostLines(lines, stored).length > 0) {
    throw new ForbiddenException(FORBIDDEN);
  }
}

/**
 * El registro de cada línea a costo nueva o cambiada, en la cotización: la línea, el precio, el
 * costo de ese momento, el motivo y quién (el `actorId`).
 */
export function atCostAuditEntries(
  actorId: string,
  quotationId: string,
  lines: readonly ResolvedSalesLine[],
  stored: readonly StoredAtCostLine[],
): AuditEntry[] {
  return atCostLineAuditEntries(actorId, 'sales.quotation.line-at-cost', {
    entity: 'quotations',
    entityId: quotationId,
    lines: changedAtCostLines(lines, stored),
  });
}

/**
 * El registro de cada línea a costo: la línea, el precio, el costo de ese momento, el motivo y
 * quién. Lo usan la cotización (D-641) y el mostrador (cc52, D-643, sobre el pedido).
 */
export function atCostLineAuditEntries(
  actorId: string,
  action: string,
  target: { entity: string; entityId: string; lines: readonly ResolvedSalesLine[] },
): AuditEntry[] {
  return target.lines.map((line) => ({
    actorId,
    action,
    entity: target.entity,
    entityId: target.entityId,
    after: {
      lineNumber: line.lineNumber,
      sku: line.productSku,
      unitValuePen: line.unitPricePen,
      ...(line.valuePerMeterPen === null ? {} : { valuePerMeterPen: line.valuePerMeterPen }),
      costPen: line.atCostFloor?.costPen ?? null,
      atCostPricePen: line.atCostFloor?.minPricePen ?? null,
      priceUnit: line.atCostFloor?.priceUnitLabel ?? null,
      atCostReason: line.atCostReason,
      ...(line.atCostNote === null ? {} : { atCostNote: line.atCostNote }),
    },
    reason: atCostReasonText(line.atCostReason, line.atCostNote) ?? undefined,
  }));
}

/**
 * Revisión de cc51 (P2): la marca que se quita también queda en la cotización. Una línea guardada
 * a costo cuyo producto ya no tiene ninguna línea a costo en la edición: se quitó la marca o la
 * línea.
 */
export function removedAtCostAuditEntries(
  actorId: string,
  quotationId: string,
  stored: readonly StoredAtCostLine[],
  lines: readonly Pick<ResolvedSalesLine, 'productId' | 'atCostReason'>[],
): AuditEntry[] {
  const stillAtCost = new Set(lines.filter((l) => Boolean(l.atCostReason)).map((l) => l.productId));
  return stored
    .filter((s) => Boolean(s.atCostReason) && !stillAtCost.has(s.productId))
    .map((s) => ({
      actorId,
      action: 'sales.quotation.line-at-cost-removed',
      entity: 'quotations',
      entityId: quotationId,
      before: {
        ...(s.lineNumber === undefined ? {} : { lineNumber: s.lineNumber }),
        productId: s.productId,
        unitValuePen: s.unitPricePen.toString(),
        atCostReason: s.atCostReason,
        ...(s.atCostNote === null ? {} : { atCostNote: s.atCostNote }),
      },
    }));
}
