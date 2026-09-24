import type { Prisma } from '@prisma/client';
import { toDecimal, type SalesPriceChangeDto } from '@ayr/shared';

/**
 * D-187: el registro de cambios de precio de las líneas de venta.
 *
 * Una cotización se edita hasta confirmarla (D-184) y el ADMINISTRADOR corrige el precio de
 * un pedido hasta que tenga comprobante. En los dos casos el documento **reescribe** su
 * importe —la cotización borra y recrea sus líneas; el pedido pisa el valor de la suya—, así
 * que sin esta tabla no quedaría rastro de a cuánto se había ofrecido antes. `audit_log`
 * guarda que hubo una edición, pero no qué línea movió qué precio, y no es algo que el
 * detalle del documento pueda leer por línea.
 */

/** Lo que hace falta de una línea para compararla antes y después. */
export interface PricedLine {
  lineNumber: number;
  productId: string;
  unitPricePen: Prisma.Decimal | string;
  valuePerMeterPen: Prisma.Decimal | string | null;
  /** Unidad de venta. Si se pasa, el emparejamiento por posición exige la misma (P2-B). */
  unit?: string;
}

export type PriceChangeHolder = { quotationId: string } | { salesOrderId: string };

/**
 * Compara las líneas de antes con las de después y registra una fila por cada línea cuyo
 * valor cambió. Devuelve cuántas registró.
 *
 * **El emparejamiento es por producto y consume**, no por número de línea: editar una
 * cotización puede reordenar o quitar líneas, y comparar la línea 2 de antes con la línea 2
 * de después registraría como «cambio de precio» lo que fue quitar una línea. Dos líneas del
 * mismo SKU se emparejan en orden, cada una con la suya. Una línea nueva o una quitada no es
 * un cambio de precio: no se registra.
 *
 * D-264: lo que quedó sin pareja por producto se empareja después **por número de línea**. Es
 * la misma línea con otro producto y otro precio —corregir el producto mal mapeado y su precio
 * en la misma edición— y se registra con el producto nuevo. Sin esto no quedaba ningún
 * registro, y el barrido pisaba ese precio creyéndolo un redondeo.
 *
 * P2-B (autorrevisión del PR #16): y solo si la unidad es la misma. Una línea quitada y otra
 * agregada en la misma posición, de productos de unidad distinta (un kg y un metro), no son la
 * misma línea corregida: registrarlas era ruido en el historial.
 */
export async function recordPriceChanges(
  tx: Prisma.TransactionClient,
  holder: PriceChangeHolder,
  before: PricedLine[],
  after: PricedLine[],
  changedById: string,
): Promise<number> {
  const pool = [...before]
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .map((line) => ({
      line,
      taken: false,
    }));
  const rows: Prisma.SalesPriceChangeCreateManyInput[] = [];
  const sorted = [...after].sort((a, b) => a.lineNumber - b.lineNumber);
  const pairs: { prev: PricedLine; next: PricedLine }[] = [];
  const unpaired: PricedLine[] = [];
  for (const next of sorted) {
    const match = pool.find((p) => !p.taken && p.line.productId === next.productId);
    if (!match) {
      unpaired.push(next);
      continue;
    }
    match.taken = true;
    pairs.push({ prev: match.line, next });
  }
  // D-264: producto y precio cambiados a la vez, en la misma posición.
  for (const next of unpaired) {
    const match = pool.find(
      (p) =>
        !p.taken &&
        p.line.lineNumber === next.lineNumber &&
        (p.line.unit ?? null) === (next.unit ?? null),
    );
    if (!match) continue;
    match.taken = true;
    pairs.push({ prev: match.line, next });
  }
  for (const { prev, next } of pairs.sort((a, b) => a.next.lineNumber - b.next.lineNumber)) {
    const sameUnit = toDecimal(prev.unitPricePen.toString()).equals(
      toDecimal(next.unitPricePen.toString()),
    );
    const samePerMeter =
      prev.valuePerMeterPen === null || next.valuePerMeterPen === null
        ? prev.valuePerMeterPen === next.valuePerMeterPen
        : toDecimal(prev.valuePerMeterPen.toString()).equals(
            toDecimal(next.valuePerMeterPen.toString()),
          );
    if (sameUnit && samePerMeter) continue;
    rows.push({
      ...holder,
      lineNumber: next.lineNumber,
      productId: next.productId,
      beforeUnitValuePen: prev.unitPricePen.toString(),
      afterUnitValuePen: next.unitPricePen.toString(),
      beforeValuePerMeterPen: prev.valuePerMeterPen?.toString() ?? null,
      afterValuePerMeterPen: next.valuePerMeterPen?.toString() ?? null,
      changedById,
    });
  }
  if (rows.length > 0) await tx.salesPriceChange.createMany({ data: rows });
  return rows.length;
}

/** El registro de un documento, del más reciente al más viejo, listo para el detalle. */
export async function findPriceChanges(
  client: Prisma.TransactionClient,
  holder: PriceChangeHolder,
): Promise<SalesPriceChangeDto[]> {
  const rows = await client.salesPriceChange.findMany({
    where: holder,
    orderBy: [{ changedAt: 'desc' }, { lineNumber: 'asc' }],
  });
  if (rows.length === 0) return [];
  const [products, users] = await Promise.all([
    client.product.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.productId))] } },
      select: { id: true, sku: true },
    }),
    client.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.changedById))] } },
      select: { id: true, name: true },
    }),
  ]);
  const skuById = new Map(products.map((p) => [p.id, p.sku]));
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    id: r.id,
    lineNumber: r.lineNumber,
    productSku: skuById.get(r.productId) ?? '',
    beforeUnitValuePen: r.beforeUnitValuePen.toFixed(4),
    afterUnitValuePen: r.afterUnitValuePen.toFixed(4),
    beforeValuePerMeterPen: r.beforeValuePerMeterPen?.toFixed(4) ?? null,
    afterValuePerMeterPen: r.afterValuePerMeterPen?.toFixed(4) ?? null,
    changedByName: nameById.get(r.changedById) ?? null,
    changedAt: r.changedAt.toISOString(),
  }));
}
