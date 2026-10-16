import { Decimal, toDecimal } from '@ayr/shared';

/**
 * cc56 (C2, D-669) — las condiciones del OK del dueño para corregir el costo de la entrada de una
 * bobina, comprobadas sobre el resultado del dry-run (y otra vez dentro de la ejecución, antes del
 * commit). Si una no se cumple, no se escribe nada.
 */

export interface AdjustedRow {
  movementId: string;
  itemId: string;
  type: string;
  refType: string | null;
  operationDate?: string;
  delta: string;
}

export interface DocumentDelta {
  number: string;
  /** Costo antes y después en Rentabilidad del comprobante. */
  profitabilityBefore: string;
  profitabilityAfter: string;
  /** Costo de sus líneas en Ventas y margen (por el despacho declarado). */
  marginBefore: string;
  marginAfter: string;
}

export interface EntryCostFacts {
  coilId: string;
  entryMovementId: string;
  addPen: string;
  adjusted: AdjustedRow[];
  documents: DocumentDelta[];
  /** Saldo de la bobina (cantidad y valor) antes y después. */
  balanceQtyBefore: string;
  balanceQtyAfter: string;
  balanceValueBefore: string;
  balanceValueAfter: string;
  /** Cuántas entradas o salidas (filas que mueven cantidad) escribió la corrida: tiene que ser 0. */
  qtyChangingRows: number;
}

export interface EntryCostExpectation {
  document: string;
  deltaPen: string;
}

const ZERO = new Decimal(0);

/** Las condiciones que no se cumplen (vacío = todo en orden). */
export function entryCostViolations(
  facts: EntryCostFacts,
  expected: EntryCostExpectation,
): string[] {
  const out: string[] = [];
  const want = toDecimal(expected.deltaPen);
  if (!toDecimal(facts.addPen).eq(want)) {
    out.push(`la entrada sube ${facts.addPen} y se esperaba ${want.toFixed(2)}`);
  }
  const others = facts.adjusted.filter((a) => a.itemId !== facts.coilId);
  if (others.length > 0) {
    out.push(`el recosteo alcanza ${String(others.length)} movimiento(s) de otros ítems`);
  }
  const entry = facts.adjusted.filter((a) => a.movementId === facts.entryMovementId);
  if (entry.length !== 1) out.push('la entrada no quedó ajustada una sola vez');
  const outs = facts.adjusted.filter(
    (a) => a.itemId === facts.coilId && a.movementId !== facts.entryMovementId,
  );
  if (outs.some((a) => a.type !== 'OUT' || a.refType !== 'SALE')) {
    out.push('el recosteo ajusta salidas de la bobina que no son la venta');
  }
  const outTotal = outs.reduce((acc, a) => acc.plus(toDecimal(a.delta)), ZERO);
  if (!outTotal.eq(want)) {
    out.push(
      `las salidas suben ${outTotal.toFixed(4)} y la entrada ${want.toFixed(2)}: no cuadra al céntimo`,
    );
  }
  if (facts.documents.length !== 1 || facts.documents[0]?.number !== expected.document) {
    out.push(
      `cambia el costo de ${facts.documents.map((d) => d.number).join(', ') || 'ningún comprobante'} y se esperaba solo ${expected.document}`,
    );
  }
  for (const d of facts.documents) {
    const p = toDecimal(d.profitabilityAfter).minus(d.profitabilityBefore);
    const m = toDecimal(d.marginAfter).minus(d.marginBefore);
    if (!p.eq(want))
      out.push(`${d.number}: Rentabilidad cambia ${p.toFixed(2)}, no ${want.toFixed(2)}`);
    if (!m.eq(want))
      out.push(`${d.number}: Ventas y margen cambia ${m.toFixed(2)}, no ${want.toFixed(2)}`);
  }
  if (!toDecimal(facts.balanceQtyBefore).eq(facts.balanceQtyAfter)) {
    out.push('la cantidad en kardex de la bobina cambió');
  }
  if (toDecimal(facts.balanceQtyAfter).isNegative())
    out.push('el saldo de la bobina queda negativo');
  if (!toDecimal(facts.balanceValueBefore).eq(facts.balanceValueAfter)) {
    out.push(
      `el valor del saldo de la bobina pasa de ${facts.balanceValueBefore} a ${facts.balanceValueAfter}`,
    );
  }
  if (facts.qtyChangingRows > 0) out.push('la corrida escribió movimientos con cantidad');
  return out;
}
