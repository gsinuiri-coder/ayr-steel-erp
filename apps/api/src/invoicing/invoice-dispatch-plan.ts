import { businessToday, Decimal } from '@ayr/shared';
import {
  cancelSameDayReversals,
  firstNegativeDate as kardexFirstNegativeDate,
  firstValidDate,
  type QtyOut,
  type QtyRow,
} from '../inventory/recost-engine';

/**
 * D-278: despacho a la fecha del comprobante, la parte que se decide sin base.
 *
 * Un comprobante emitido cuya mercadería nunca se registró como despachada deja el kardex con
 * stock que ya no está y la reserva del pedido viva para siempre. Este plan decide, línea por
 * línea, qué hacer con lo facturado y no despachado:
 *
 * - `DISPATCH`: se registra el despacho con fecha de operación = fecha de emisión, por el
 *   servicio de despacho (salida `SALE` por `InventoryService.record`).
 * - `BEFORE_OPENING`: el comprobante es **anterior al saldo inicial** (la carga inicial) del
 *   ítem, así que esa mercadería ya había salido cuando se contó el inventario. No hay salida
 *   que registrar: se entrega la línea sin tocar el kardex y se libera su reserva.
 * - `REVIEW`: no se toca. O la línea necesita producción que no se reportó, o la salida
 *   retroactiva dejaría el kardex negativo en alguna fecha intermedia.
 *
 * Las salidas que el mismo plan crea se acumulan por ítem, en el orden de los comprobantes:
 * dos facturas que juntas no caben no pasan las dos.
 */

export interface PlanMovement {
  /** Fecha de operación, `YYYY-MM-DD`. */
  date: string;
  /** Positivo si entra, negativo si sale. Un ajuste de costo es cero. */
  signedQty: Decimal;
}

export interface PlanItemKardex {
  /** Fecha de la carga inicial del ítem (su primera entrada `IMPORT`), o null si no tiene. */
  openingDate: string | null;
  /** Movimientos en el orden del kardex: fecha de operación y, dentro del día, el de grabación. */
  movements: PlanMovement[];
}

export type PlanTarget =
  | {
      ok: true;
      itemKey: string;
      reserveQty: Decimal;
      /**
       * Lo fabricado y reservado para la línea de pedido (cupo), o null si la línea no sale de
       * producción propia. Se reparte entre los comprobantes de la línea en orden de emisión y
       * solo lo gasta la línea que se entrega (D-287).
       */
      held?: { qty: Decimal; unit: string } | null;
    }
  | { ok: false; reason: string };

export interface PlanInvoiceLine {
  orderItemId: string;
  lineNumber: number;
  sku: string;
  /** Lo facturado y todavía no despachado, en la unidad de venta. */
  qty: Decimal;
  target: PlanTarget;
  /**
   * D-285: la salida no puede ser anterior a esta fecha (el último parte de producción que
   * generó el stock de la línea). La salida va el día más tardío entre la emisión y este.
   */
  notBefore?: string | null;
}

export interface PlanInvoice {
  invoiceId: string;
  number: string;
  salesOrderId: string;
  issueDate: string;
  /** D-364: fecha elegida por el usuario; sin valor conserva el default D-285. */
  dispatchDate?: string;
  lines: PlanInvoiceLine[];
}

export type PlanAction = 'DISPATCH' | 'BEFORE_OPENING' | 'REVIEW';

export interface PlannedLine {
  orderItemId: string;
  lineNumber: number;
  sku: string;
  qty: Decimal;
  /** En la unidad del kardex (kilos de la bobina en una venta directa). Cero en revisión. */
  reserveQty: Decimal;
  itemKey: string | null;
  action: PlanAction;
  operationDate: string;
  reason: string | null;
  firstValidDate: string | null;
}

/** El kardex simulado del plan en el formato del motor (D-652). */
function qtyRows(movements: readonly PlanMovement[]): QtyRow[] {
  return movements.map((m) => ({ date: m.date, delta: m.signedQty }));
}

export interface PlannedInvoice {
  invoiceId: string;
  number: string;
  salesOrderId: string;
  issueDate: string;
  lines: PlannedLine[];
}

/**
 * Primera fecha en que el saldo corrido queda negativo si se suman `extraOuts` (salidas
 * nuevas, cada una al **final** de su día: se graban después que todo lo que ya existe), o
 * null si nunca. cc54: es el mismo cálculo que el kardex (`firstNegativeDate` del motor, D-652):
 * lo que el plan acepta, `InventoryService.record` lo acepta, y un punto que ya estaba negativo
 * sin las salidas nuevas no manda a revisión.
 */
export function firstNegativeDate(
  movements: readonly PlanMovement[],
  extraOuts: readonly QtyOut[],
): string | null {
  return kardexFirstNegativeDate(qtyRows(movements), extraOuts);
}

export function planInvoiceDispatches(
  invoices: readonly PlanInvoice[],
  kardexByItem: ReadonlyMap<string, PlanItemKardex>,
  /** Salidas que se crean antes que este plan (D-285): se suman al kardex simulado. */
  priorOuts: ReadonlyMap<string, readonly { date: string; qty: Decimal }[]> = new Map(),
): PlannedInvoice[] {
  const outsByItem = new Map<string, { date: string; qty: Decimal }[]>(
    [...priorOuts].map(([k, v]) => [k, [...v]]),
  );
  // D-287: el cupo de lo fabricado y reservado se gasta solo cuando la línea se entrega
  // (DISPATCH o BEFORE_OPENING, que también descuenta la reserva). Si va a revisión, el cupo
  // sigue disponible para el comprobante siguiente de la misma línea de pedido.
  const heldUsed = new Map<string, Decimal>();
  const ordered = [...invoices].sort((a, b) =>
    a.issueDate === b.issueDate
      ? a.number.localeCompare(b.number)
      : a.issueDate < b.issueDate
        ? -1
        : 1,
  );
  return ordered.map((inv) => ({
    invoiceId: inv.invoiceId,
    number: inv.number,
    salesOrderId: inv.salesOrderId,
    issueDate: inv.issueDate,
    lines: inv.lines.map((line): PlannedLine => {
      const base = {
        orderItemId: line.orderItemId,
        lineNumber: line.lineNumber,
        sku: line.sku,
        qty: line.qty,
        // D-364 permite elegir una fecha, pero no adelanta el stock producido: el parte sigue
        // siendo el piso de la salida aunque la fecha elegida quede antes de la emisión.
        operationDate:
          line.notBefore !== undefined &&
          line.notBefore !== null &&
          line.notBefore > (inv.dispatchDate ?? inv.issueDate)
            ? line.notBefore
            : (inv.dispatchDate ?? inv.issueDate),
      };
      if (!line.target.ok) {
        return {
          ...base,
          reserveQty: new Decimal(0),
          itemKey: null,
          action: 'REVIEW',
          reason: line.target.reason,
          firstValidDate: null,
        };
      }
      const { itemKey, reserveQty, held } = line.target;
      const used = heldUsed.get(line.orderItemId) ?? new Decimal(0);
      if (held !== undefined && held !== null) {
        const left = Decimal.max(new Decimal(0), held.qty.minus(used));
        if (reserveQty.gt(left)) {
          return {
            ...base,
            reserveQty: new Decimal(0),
            itemKey: null,
            action: 'REVIEW',
            reason: `Hay ${left.toFixed(3)} ${held.unit} fabricados y reservados para la línea y se facturaron ${reserveQty.toFixed(3)}: falta producir`,
            firstValidDate: null,
          };
        }
      }
      const consumeHeld = (): void => {
        if (held !== undefined && held !== null) {
          heldUsed.set(line.orderItemId, used.plus(reserveQty));
        }
      };
      const kardex = kardexByItem.get(itemKey) ?? { openingDate: null, movements: [] };
      // Una bobina tiene identidad: si estaba en la carga inicial, estaba en el almacén cuando
      // se contó y no pudo salir antes. Entregarla sin salida la dejaría vendible otra vez.
      if (
        kardex.openingDate !== null &&
        base.operationDate < kardex.openingDate &&
        itemKey.startsWith('COIL:')
      ) {
        return {
          ...base,
          reserveQty,
          itemKey,
          action: 'REVIEW',
          reason: `La bobina está en el inventario inicial (${kardex.openingDate}) y el comprobante es anterior`,
          firstValidDate: null,
        };
      }
      if (kardex.openingDate !== null && base.operationDate < kardex.openingDate) {
        consumeHeld();
        return {
          ...base,
          reserveQty,
          itemKey,
          action: 'BEFORE_OPENING',
          reason: `Entregado antes del inventario inicial (${kardex.openingDate})`,
          firstValidDate: null,
        };
      }
      const outs = outsByItem.get(itemKey) ?? [];
      const candidate = [...outs, { date: base.operationDate, qty: reserveQty }];
      const negativeOn = firstNegativeDate(kardex.movements, candidate);
      if (negativeOn !== null) {
        return {
          ...base,
          reserveQty,
          itemKey,
          action: 'REVIEW',
          reason: `Una salida el ${base.operationDate} deja el kardex negativo el ${negativeOn}`,
          firstValidDate: firstValidDate(
            qtyRows(kardex.movements),
            base.operationDate,
            reserveQty,
            businessToday(),
            outs,
          ),
        };
      }
      outsByItem.set(itemKey, candidate);
      consumeHeld();
      return {
        ...base,
        reserveQty,
        itemKey,
        action: 'DISPATCH',
        reason: null,
        firstValidDate: null,
      };
    }),
  }));
}

/** Motivo de la reversa y del despacho nuevo cuando se corrige la fecha de emisión (D-288). */
export const REDATE_REASON = 'corrección de la fecha de emisión del comprobante (D-288)';

/**
 * D-288: saca del kardex simulado los pares salida/reversa que caen el mismo día. Netean cero
 * dentro del día, pero recorridos evento por evento dejan un negativo de paso entre los dos (la
 * salida vieja antes de su reversa) que `firstNegativeDate` leía como un kardex negativo de verdad.
 * cc54 (un solo cálculo con D-652): todos los pares del mismo día, no solo los del re-fechado; es la
 * regla con que el kardex juzga la salida (`qtyRowsOf`). Una reversa de otro día sí cambia el saldo
 * entre las dos fechas y se queda.
 */
export function dropSameDayReversals<
  T extends {
    id: bigint | string;
    reversalOfId: bigint | string | null;
    date: string;
  },
>(movements: readonly T[]): T[] {
  return cancelSameDayReversals(movements);
}

/**
 * Cuánto de cada comprobante de una línea de pedido quedó sin despachar. Lo ya despachado
 * cubre primero los comprobantes más antiguos (`invoiced` viene en ese orden), y nada supera
 * lo que le queda pendiente al pedido.
 */
export function allocateUndispatched(
  ordered: Decimal,
  dispatched: Decimal,
  invoiced: readonly Decimal[],
): Decimal[] {
  let covered = dispatched;
  let pending = Decimal.max(new Decimal(0), ordered.minus(dispatched));
  return invoiced.map((qty) => {
    const coveredHere = Decimal.min(qty, covered);
    covered = covered.minus(coveredHere);
    const take = Decimal.min(qty.minus(coveredHere), pending);
    pending = pending.minus(take);
    return take;
  });
}
