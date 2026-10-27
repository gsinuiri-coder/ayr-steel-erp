import { BadRequestException } from '@nestjs/common';
import { Decimal, type InventoryItemType } from '@ayr/shared';

/**
 * cc52 (D-646): de qué despachos sale la devolución de una línea, cuánto y a qué costo. Función
 * pura: el servicio lee lo despachado y lo ya devuelto, y escribe lo que esto decide.
 */

/** Una línea de despacho vigente de la línea de pedido, con lo que ya se devolvió de ella. */
export interface DispatchLineStock {
  dispatchItemId: string;
  dispatchId: string;
  dispatchCode: string;
  /** `YYYY-MM-DD`. */
  dispatchDate: string;
  dispatchSeq: number;
  /** El comprobante que declara el despacho (D-205), si lo tiene. */
  invoiceId: string | null;
  itemType: InventoryItemType;
  itemId: string;
  /** En la unidad de venta. */
  qty: Decimal;
  /** En la unidad del kardex (lo que movió el despacho). */
  reserveQty: Decimal;
  returnedQty: Decimal;
  returnedReserveQty: Decimal;
  returnedTotalCost: Decimal;
  movementId: bigint;
  /** Costo unitario y total del `OUT` del despacho: el costo con que salió. */
  unitCost: Decimal;
  totalCost: Decimal;
  unit: string;
  businessLineId: string;
}

export interface ReturnAllocation {
  stock: DispatchLineStock;
  qty: Decimal;
  reserveQty: Decimal;
  unitCost: Decimal;
  totalCost: Decimal;
  /**
   * cc69 (D-728): `YYYY-MM-DD` en que la parte vuelve al almacén: la fecha de la NC o, si sale de
   * un despacho posterior a la NC, la de ese despacho.
   */
  operationDate: string;
}

const ZERO = new Decimal(0);
/**
 * cc69: el rechazo de una línea sin nada despachado. El servicio lo reconoce para nombrar lo
 * entregado antes del inventario inicial (sin salida de kardex), en vez de comparar el texto.
 */
export class NothingDispatchedError extends BadRequestException {
  constructor(readonly at: string) {
    super(
      `${at}: no hay nada despachado de este comprobante; si la mercadería no salió del almacén, usa «Rebajar el precio».`,
    );
  }
}
/** La menor cantidad que el kardex registra (3 decimales). */
const KARDEX_STEP = new Decimal('0.001');

export interface ReturnPlanOptions {
  /**
   * Revisión de cc52 (P1): primero los despachos que declara el comprobante acreditado. cc69
   * (D-728): dentro de cada grupo; un despacho anterior a la NC va antes que uno posterior aunque
   * este sea el declarado.
   */
  affectedInvoiceId?: string | null;
  /**
   * La fecha de la NC. cc69 (D-728): primero los despachos hasta esa fecha; lo que falte, de los
   * posteriores, que reingresan en la fecha de su despacho.
   */
  asOf?: string;
  /** cc54 (D-656, 01): devolver hasta lo disponible, sin error si es menos (o nada). */
  upToAvailable?: boolean;
  /** cc54 (D-656, 01): solo despachos del comprobante acreditado o sin comprobante declarado. */
  onlyAffected?: boolean;
}

/**
 * Reparte `qty` (unidad de venta) sobre las líneas de despacho, sin pasar de lo despachado menos lo
 * ya devuelto de cada una. Primero las de fecha hasta la NC (`asOf`), **de la más reciente hacia
 * atrás** (fecha y correlativo); cc69 (D-728): lo que falte, de las posteriores a la NC, **de la más
 * cercana en adelante**, y esa parte reingresa en la fecha de su despacho.
 *
 * - El costo es el del `OUT` de ese despacho. Si se devuelve todo lo que le quedaba a la línea,
 *   el total es exactamente lo que le queda de valor (sin redondeos acumulados); si no, la parte
 *   proporcional en la unidad del kardex × su costo unitario.
 * - Una bobina se devuelve **entera** (lo que le queda a su línea de despacho).
 */
export function planReturnAllocation(
  lineNumber: number,
  qty: Decimal,
  stock: readonly DispatchLineStock[],
  /** Revisión de cc52 (P1): primero los despachos que declara el comprobante acreditado. */
  options: ReturnPlanOptions = {},
): ReturnAllocation[] {
  const at = `Línea ${String(lineNumber)}`;
  if (qty.lte(0))
    throw new BadRequestException(`${at}: la cantidad a devolver debe ser mayor a cero`);
  const preferred = (s: DispatchLineStock) =>
    options.affectedInvoiceId && s.invoiceId === options.affectedInvoiceId ? 0 : 1;
  const asOf = options.asOf;
  const afterNote = (s: DispatchLineStock) => asOf !== undefined && s.dispatchDate > asOf;
  const ordered = stock
    // cc54 (D-656): la anulación (01) solo devuelve lo que salió por ese comprobante o sin
    // comprobante declarado; lo despachado para otro comprobante del pedido es de ese otro.
    .filter(
      (s) =>
        !options.onlyAffected ||
        s.invoiceId === null ||
        s.invoiceId === (options.affectedInvoiceId ?? null),
    )
    .sort((a, b) => {
      const later = Number(afterNote(a)) - Number(afterNote(b));
      if (later !== 0) return later;
      // cc69 (D-728): los posteriores a la NC, del más cercano a ella en adelante.
      const direction = afterNote(a) ? -1 : 1;
      return (
        preferred(a) - preferred(b) ||
        direction * b.dispatchDate.localeCompare(a.dispatchDate) ||
        direction * (b.dispatchSeq - a.dispatchSeq)
      );
    });
  const dispatched = ordered.reduce((acc, s) => acc.plus(s.qty), ZERO);
  const available = ordered.reduce(
    (acc, s) => acc.plus(Decimal.max(s.qty.minus(s.returnedQty), ZERO)),
    ZERO,
  );
  // cc54 (D-656): el 01 devuelve **hasta** lo despachado; lo que no salió no vuelve.
  if (options.upToAvailable && available.lte(0)) return [];
  const wanted = options.upToAvailable ? Decimal.min(qty, available) : qty;
  // cc69: sin nada disponible, la causa real (no salió nada, o ya se devolvió todo), no «hay 0.000».
  if (dispatched.lte(0)) throw new NothingDispatchedError(at);
  if (available.lte(0)) {
    throw new BadRequestException(
      `${at}: lo despachado (${dispatched.toFixed(3)}) ya se devolvió entero; no queda nada por devolver.`,
    );
  }
  if (wanted.gt(available)) {
    throw new BadRequestException(
      `${at}: hay ${available.toFixed(3)} despachado sin devolver y se intenta devolver ${wanted.toFixed(3)}. Una devolución no pasa de lo vendido menos lo ya devuelto; si no salió del almacén, usa «Rebajar el precio».`,
    );
  }
  let remaining = wanted;
  const out: ReturnAllocation[] = [];
  for (const s of ordered) {
    if (remaining.lte(0)) break;
    const left = s.qty.minus(s.returnedQty);
    if (left.lte(0)) continue;
    const take = Decimal.min(left, remaining);
    const whole = take.equals(left);
    if (s.itemType === 'COIL' && !whole) {
      throw new BadRequestException(
        `${at}: una bobina se devuelve entera (${left.toFixed(3)} del despacho ${s.dispatchCode})`,
      );
    }
    const leftReserve = s.reserveQty.minus(s.returnedReserveQty);
    // cc57 (D-14 de audit-01): una devolución parcial deja siempre algo del kardex para lo que
    // queda por devolver; si el prorrateo a 3 decimales se lo llevaba todo, la última devolución
    // salía «demasiado chica» con unidades todavía afuera.
    const reserveQty = whole
      ? leftReserve
      : Decimal.min(
          s.reserveQty.times(take).div(s.qty).toDecimalPlaces(3),
          leftReserve.minus(KARDEX_STEP),
        );
    if (reserveQty.lte(0)) {
      throw new BadRequestException(
        whole
          ? `${at}: la cantidad a devolver es demasiado chica para el kardex (${take.toFixed(3)})`
          : `${at}: la cantidad a devolver es demasiado chica para el kardex (${take.toFixed(3)}); devuelve lo que queda del despacho ${s.dispatchCode} entero (${left.toFixed(3)})`,
      );
    }
    const totalCost = whole
      ? s.totalCost.minus(s.returnedTotalCost)
      : reserveQty.times(s.unitCost).toDecimalPlaces(4);
    out.push({
      stock: s,
      qty: take,
      reserveQty,
      unitCost: totalCost.div(reserveQty).toDecimalPlaces(4),
      totalCost,
      operationDate: afterNote(s) ? s.dispatchDate : (asOf ?? s.dispatchDate),
    });
    remaining = remaining.minus(take);
  }
  return out;
}
