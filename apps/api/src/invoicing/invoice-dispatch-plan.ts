import { Decimal } from '@ayr/shared';

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
 * null si nunca.
 */
export function firstNegativeDate(
  movements: readonly PlanMovement[],
  extraOuts: readonly { date: string; qty: Decimal }[],
): string | null {
  const events = [
    ...movements.map((m, i) => ({ date: m.date, rank: 0, order: i, delta: m.signedQty })),
    ...extraOuts.map((o, i) => ({ date: o.date, rank: 1, order: i, delta: o.qty.negated() })),
  ].sort((a, b) =>
    a.date === b.date
      ? a.rank === b.rank
        ? a.order - b.order
        : a.rank - b.rank
      : a.date < b.date
        ? -1
        : 1,
  );
  let running = new Decimal(0);
  for (const e of events) {
    running = running.plus(e.delta);
    if (running.isNegative()) return e.date;
  }
  return null;
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
        operationDate:
          line.notBefore !== undefined && line.notBefore !== null && line.notBefore > inv.issueDate
            ? line.notBefore
            : inv.issueDate,
      };
      if (!line.target.ok) {
        return {
          ...base,
          reserveQty: new Decimal(0),
          itemKey: null,
          action: 'REVIEW',
          reason: line.target.reason,
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
        };
      }
      outsByItem.set(itemKey, candidate);
      consumeHeld();
      return { ...base, reserveQty, itemKey, action: 'DISPATCH', reason: null };
    }),
  }));
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
