import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { atCostReasonText, toDecimal } from '@ayr/shared';
import type { AuditEntry } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import type { ResolvedSalesLine } from './sales-lines';

/**
 * cc51 (D-641): vender a costo. Funciones puras que usa la cotización (alta, edición y duplicado):
 * quién puede marcar una línea y qué queda en la auditoría. El piso a costo en sí lo comprueba
 * `assertPriceFloor`, que no conoce el rol.
 */

/** Una línea a costo que la cotización ya tenía guardada. */
export interface StoredAtCostLine {
  productId: string;
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
    stored.atCostReason !== null &&
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
    if (line.atCostReason === null) return false;
    const match = unused.findIndex((s) => sameAtCostLine(line, s));
    if (match === -1) return true;
    unused.splice(match, 1);
    return false;
  });
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
    throw new ForbiddenException(
      'Solo un administrador puede vender a costo. Una línea que ya estaba a costo puede quedar igual, pero no cambiarse.',
    );
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
  return changedAtCostLines(lines, stored).map((line) => ({
    actorId,
    action: 'sales.quotation.line-at-cost',
    entity: 'quotations',
    entityId: quotationId,
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
