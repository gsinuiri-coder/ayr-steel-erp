import {
  DERIVED_UNIT_VALUE_DECIMALS,
  derivedUnitValue,
  serializeSalesTotals,
  sumLineTotals,
  toDecimal,
  toFixedString,
  type ReactivationLineDto,
  type ReactivationSideDto,
} from '@ayr/shared';

/**
 * D-378: el cálculo de «Reactivar con las líneas actuales del pedido», sin base de datos.
 *
 * El comprobante pasa a facturar **el pedido entero** (decisión 1 del dueño): cada línea del
 * pedido por su cantidad completa. Es la misma cuenta que hace «Emitir comprobante» para una
 * línea entera a su propio precio (`partKind` = `FULL`, D-169/D-255): el importe se **copia** de
 * la línea del pedido, que es el del papel, y el unitario sale de ese importe con diez decimales
 * (D-255). La cabecera suma las líneas con `sumLineTotals` (D-377).
 *
 * Las filas se reescriben **en su lugar** (decisión 3): la línea del comprobante que ya
 * facturaba una línea del pedido conserva su id, su número, su descripción y su unidad (son las
 * del papel) y toma cantidad e importes del pedido. Las líneas del pedido que el comprobante no
 * tenía se agregan al final, en el orden del pedido. Nunca se borra una fila: hoy una línea de
 * pedido no se puede quitar (H7), así que toda línea del comprobante sigue teniendo la suya.
 */

export interface DocumentLineRow {
  id: string;
  lineNumber: number;
  productId: string | null;
  description: string;
  qty: { toString(): string };
  unit: string;
  unitPricePen: { toString(): string };
  subtotalPen: { toString(): string };
  igvPen: { toString(): string };
  totalPen: { toString(): string };
  salesOrderItemId: string | null;
}

export interface OrderLineRow {
  id: string;
  lineNumber: number;
  productId: string;
  description: string;
  qty: { toString(): string };
  unit: string;
  subtotalPen: { toString(): string };
  igvPen: { toString(): string };
  totalPen: { toString(): string };
}

interface LineAmounts {
  qty: string;
  unitPricePen: string;
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
}

export interface OrderLinesPlan {
  /**
   * Filas que ya existen: se actualizan por id con estos valores. `productId`, `description` y
   * `unit` son los de la fila salvo que la línea del pedido haya cambiado de producto.
   *
   * `salesOrderItemId` es la línea del pedido que la fila factura **después**. En D-378 es la
   * misma de antes; al traer el comprobante a otro pedido (D-381) es la del destino, y escribirla
   * es lo que hace que la facturación por línea, el despacho y los reportes lean el pedido nuevo
   * (revisión del segundo modelo del diseño D-381, P1).
   */
  updates: ({
    id: string;
    productId: string;
    description: string;
    unit: string;
    salesOrderItemId: string;
  } & LineAmounts)[];
  /** Filas nuevas, con su número de línea ya asignado. */
  creates: ({
    lineNumber: number;
    productId: string;
    description: string;
    unit: string;
    salesOrderItemId: string;
  } & LineAmounts)[];
  before: ReactivationSideDto;
  after: ReactivationSideDto;
  /** `false` si el pedido describe exactamente lo que el comprobante ya tenía. */
  changed: boolean;
}

/** Los importes de una línea del pedido facturada entera (D-169/D-255). */
function fullLineAmounts(o: OrderLineRow): LineAmounts {
  const qty = o.qty.toString();
  const price = derivedUnitValue(qty, o.subtotalPen.toString()).toFixed(
    DERIVED_UNIT_VALUE_DECIMALS,
  );
  return {
    qty: toFixedString(qty, 'KG'),
    unitPricePen: toFixedString(price, 'MONEY'),
    subtotalPen: toFixedString(o.subtotalPen.toString(), 'MONEY'),
    igvPen: toFixedString(o.igvPen.toString(), 'MONEY'),
    totalPen: toFixedString(o.totalPen.toString(), 'MONEY'),
  };
}

/** Para comparar dos líneas por cantidad e importes, ya serializados a su escala. */
function amountsKey(l: LineAmounts): string {
  return [l.qty, l.unitPricePen, l.subtotalPen, l.igvPen, l.totalPen].join('|');
}

/** La cabecera grabada de un comprobante. */
export interface StoredHeader {
  subtotalPen: { toString(): string };
  igvPen: { toString(): string };
  totalPen: { toString(): string };
}

function side(lines: ReactivationLineDto[], header?: StoredHeader): ReactivationSideDto {
  if (!header) return { lines, ...serializeSalesTotals(sumLineTotals(lines)) };
  return {
    lines,
    subtotalPen: toFixedString(header.subtotalPen.toString(), 'MONEY'),
    igvPen: toFixedString(header.igvPen.toString(), 'MONEY'),
    totalPen: toFixedString(header.totalPen.toString(), 'MONEY'),
  };
}

/**
 * D-381: cuando el comprobante cambia de pedido, qué línea del destino factura cada fila
 * (`pairing`, por id de fila) y las líneas del pedido de **origen**, para que el «antes» siga
 * nombrando la línea que la fila facturaba (revisión del segundo modelo, P2).
 */
export interface MovePlanOptions {
  pairing: ReadonlyMap<string, string>;
  sourceOrderLines: readonly { id: string; lineNumber: number }[];
}

/**
 * Arma el plan. Supone lo que el servicio ya comprobó: todas las líneas del comprobante vienen
 * del pedido, ninguna línea del pedido aparece dos veces y todas las de `documentLines` están en
 * `orderLines`. Con `move` (D-381), lo mismo pero a través del emparejado: cada fila tiene su
 * línea del destino en `move.pairing`.
 *
 * `storedHeader` es la cabecera **grabada** del comprobante, y el «antes» la muestra tal cual
 * (autorrevisión cc13, P2-2): recalcularla con D-377 podía diferir en céntimos en un manual
 * anterior a D-377, y la auditoría perdía el valor real.
 */
export function planOrderLines(
  documentLines: readonly DocumentLineRow[],
  orderLines: readonly OrderLineRow[],
  storedHeader?: StoredHeader,
  move?: MovePlanOptions,
): OrderLinesPlan {
  const orderById = new Map(orderLines.map((o) => [o.id, o]));
  const targetOf = (d: DocumentLineRow): string | null =>
    move ? (move.pairing.get(d.id) ?? null) : d.salesOrderItemId;
  const byOrderItem = new Set(documentLines.flatMap((d) => targetOf(d) ?? []));
  const beforeLineNumber = new Map(
    (move ? move.sourceOrderLines : orderLines).map((o) => [o.id, o.lineNumber]),
  );
  const docSorted = [...documentLines].sort((a, b) => a.lineNumber - b.lineNumber);
  const orderSorted = [...orderLines].sort((a, b) => a.lineNumber - b.lineNumber);

  const before: ReactivationLineDto[] = docSorted.map((d) => ({
    lineNumber: d.lineNumber,
    orderLineNumber: d.salesOrderItemId ? (beforeLineNumber.get(d.salesOrderItemId) ?? 0) : 0,
    description: d.description,
    qty: toFixedString(d.qty.toString(), 'KG'),
    unit: d.unit,
    unitPricePen: toFixedString(d.unitPricePen.toString(), 'MONEY'),
    subtotalPen: toFixedString(d.subtotalPen.toString(), 'MONEY'),
    igvPen: toFixedString(d.igvPen.toString(), 'MONEY'),
    totalPen: toFixedString(d.totalPen.toString(), 'MONEY'),
    added: false,
  }));

  const updates: OrderLinesPlan['updates'] = [];
  const creates: OrderLinesPlan['creates'] = [];
  const afterExisting: ReactivationLineDto[] = [];
  const afterAdded: ReactivationLineDto[] = [];
  let next = docSorted.reduce((max, d) => Math.max(max, d.lineNumber), 0);
  let changed = false;

  for (const d of docSorted) {
    const target = targetOf(d);
    const o = target ? orderById.get(target) : undefined;
    if (!o) continue;
    const amounts = fullLineAmounts(o);
    const prev = before.find((b) => b.lineNumber === d.lineNumber);
    if (!prev || amountsKey(prev) !== amountsKey(amounts)) changed = true;
    // Autorrevisión cc13 (P2-1): si la línea del pedido cambió de producto mientras el comprobante
    // estuvo anulado (otra bobina), la fila toma el producto nuevo con su descripción y su unidad.
    // Con el viejo, «Ventas por material» y el margen —que agrupan por el producto de la línea del
    // comprobante— dejarían la venta en el material anterior.
    const productChanged = d.productId !== o.productId;
    if (productChanged) changed = true;
    const description = productChanged ? o.description : d.description;
    const unit = productChanged ? o.unit : d.unit;
    updates.push({
      id: d.id,
      productId: o.productId,
      description,
      unit,
      salesOrderItemId: o.id,
      ...amounts,
    });
    afterExisting.push({
      lineNumber: d.lineNumber,
      orderLineNumber: o.lineNumber,
      description,
      unit,
      ...amounts,
      added: false,
      ...(productChanged ? { productChanged: true } : {}),
    });
  }

  for (const o of orderSorted) {
    if (byOrderItem.has(o.id)) continue;
    changed = true;
    next += 1;
    const amounts = fullLineAmounts(o);
    creates.push({
      lineNumber: next,
      productId: o.productId,
      description: o.description,
      unit: o.unit,
      salesOrderItemId: o.id,
      ...amounts,
    });
    afterAdded.push({
      lineNumber: next,
      orderLineNumber: o.lineNumber,
      description: o.description,
      unit: o.unit,
      ...amounts,
      added: true,
    });
  }

  return {
    updates,
    creates,
    before: side(before, storedHeader),
    after: side([...afterExisting, ...afterAdded]),
    changed,
  };
}

/**
 * D-378: el total del papel tipeado contra el de las líneas nuevas, **al céntimo**. Devuelve la
 * diferencia (papel − líneas) o `null` si coinciden.
 */
export function paperTotalDifference(paperTotalPen: string, linesTotalPen: string): string | null {
  const diff = toDecimal(paperTotalPen).minus(toDecimal(linesTotalPen));
  return diff.isZero() ? null : diff.toFixed(2);
}
