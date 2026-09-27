import { InventoryItemType, QuotationStatus, type Prisma } from '@prisma/client';
import { businessToday, quotationCode, salesOrderCode, toDateOnly } from '@ayr/shared';
import { isCoilSaleProduct } from '../sales/coil-sale-product';
import { coilCodesEverInPool, type ProductUsageIdentity } from './product-usage';

/**
 * **«Uso real» de un producto: lo que impide cambiarle subtipo, espesor o color (D-348).**
 *
 * Es una pregunta distinta de la del borrado (D-347, `product-usage.ts`), y a propósito más
 * laxa: borrar no tiene reversa y cualquier cotización —anulada o no— lo impide; cambiar la
 * estructura de un SKU solo rompe algo si hay un hecho **vivo** que la leyó. Cuentan el kardex y
 * los saldos, las compras, los pedidos, los comprobantes, los despachos, las órdenes de
 * producción, las reservas de pedido, las bobinas del pool de un `BOB…` y las cotizaciones que
 * **no** están anuladas ni vencidas (con sus reservas temporales y su historial de precio por
 * línea). **No cuentan** (decisión del dueño): las cotizaciones ANULADAS o VENCIDAS con sus
 * reservas temporales y su historial de precio, las recetas históricas (`product_boms`, D-344),
 * ser destino de una fusión (D-253), el historial de precio de lista ni `audit_log`.
 */

const PRODUCT = InventoryItemType.PRODUCT;

/** Las cotizaciones que ya no comprometen nada: anuladas o vencidas. */
export const DEAD_QUOTATION_STATUSES: readonly QuotationStatus[] = [
  QuotationStatus.CANCELLED,
  QuotationStatus.EXPIRED,
];

/**
 * Una cotización viva: ni anulada ni vencida. «Vencida» también es la EMITIDA cuyo `validUntil`
 * ya pasó aunque el job diario todavía no la haya marcado `EXPIRED` (el mismo criterio que
 * `isQuotationExpired`/`confirm()`; segundo modelo, P1). `validUntil` nulo no vence (D-157).
 */
function liveQuotation(): Prisma.QuotationWhereInput {
  return {
    status: { notIn: [...DEAD_QUOTATION_STATUSES] },
    NOT: {
      status: QuotationStatus.EMITTED,
      validUntil: { lt: toDateOnly(businessToday()) },
    },
  };
}

function list(codes: readonly string[]): string {
  const unique = [...new Set(codes)];
  return `${unique.slice(0, 3).join(', ')}${unique.length > 3 ? '…' : ''}`;
}

/**
 * Qué usa **de verdad** a este producto, en español y listo para el rechazo. `[]` = se puede
 * cambiar su subtipo, espesor y color. Nombra los documentos (cotización y pedido) porque es lo
 * que el dueño tiene que ir a mirar; el resto va como conteo.
 */
export async function describeProductRealUsage(
  tx: Prisma.TransactionClient,
  product: ProductUsageIdentity & { name: string },
): Promise<string[]> {
  const where = { productId: product.id };
  const [
    movements,
    balances,
    purchaseItems,
    orderItems,
    fiscalItems,
    dispatchItems,
    productionOrders,
    reservations,
    quotationItems,
    quotationReservations,
    coilCodes,
  ] = await Promise.all([
    tx.inventoryMovement.count({ where: { itemType: PRODUCT, itemId: product.id } }),
    tx.inventoryBalance.count({ where: { itemType: PRODUCT, itemId: product.id } }),
    tx.purchaseItem.count({ where }),
    tx.salesOrderItem.findMany({
      where,
      select: { salesOrder: { select: { seq: true } } },
    }),
    tx.fiscalDocumentItem.count({ where }),
    tx.dispatchItem.count({ where }),
    tx.productionOrder.count({ where }),
    tx.reservation.count({ where: { itemType: PRODUCT, itemId: product.id } }),
    tx.quotationItem.findMany({
      where: { ...where, quotation: liveQuotation() },
      select: { quotation: { select: { seq: true } } },
    }),
    tx.quotationReservation.count({
      where: { itemType: PRODUCT, itemId: product.id, quotation: liveQuotation() },
    }),
    isCoilSaleProduct(product) ? coilCodesEverInPool(tx, product) : Promise.resolve([]),
  ]);

  const reasons: string[] = [];
  if (movements > 0) reasons.push(`${String(movements)} movimiento(s) de kardex`);
  if (balances > 0 && movements === 0) reasons.push('saldo de inventario');
  if (purchaseItems > 0) reasons.push(`${String(purchaseItems)} línea(s) de compra`);
  if (orderItems.length > 0) {
    reasons.push(`pedido(s) ${list(orderItems.map((i) => salesOrderCode(i.salesOrder.seq)))}`);
  }
  if (fiscalItems > 0) reasons.push(`${String(fiscalItems)} línea(s) de comprobante`);
  if (dispatchItems > 0) reasons.push(`${String(dispatchItems)} línea(s) de despacho`);
  if (productionOrders > 0) reasons.push(`${String(productionOrders)} orden(es) de producción`);
  if (reservations > 0) reasons.push(`${String(reservations)} reserva(s) de pedido`);
  if (quotationItems.length > 0) {
    reasons.push(
      `cotización(es) vigente(s) ${list(quotationItems.map((i) => quotationCode(i.quotation.seq)))}`,
    );
  }
  // Las reservas temporales cuelgan de una cotización viva, que ya se nombró arriba: solo se
  // mencionan si por algún motivo la cotización no trajo línea (no debería pasar).
  if (quotationReservations > 0 && quotationItems.length === 0) {
    reasons.push(`${String(quotationReservations)} reserva(s) temporal(es) de cotización`);
  }
  if (coilCodes.length > 0) reasons.push(`bobina(s) de su pool (${list(coilCodes)})`);
  return reasons;
}

/**
 * El mismo criterio para una tanda (el catálogo entero): una consulta por tabla, nunca una por
 * producto (AGENTS §3.4). Devuelve, por cada producto usado, las **categorías** de uso («kardex»,
 * «pedido»…), que es lo que el diálogo muestra como motivo; el detalle con los números de
 * documento lo da `describeProductRealUsage` en el rechazo. El pool de bobinas agrega dos
 * consultas por cada `BOB…` que ninguna tabla ya marcó, igual que `productsWithUsage`.
 */
export async function productsRealUsage(
  tx: Prisma.TransactionClient,
  products: readonly (ProductUsageIdentity & { name: string })[],
): Promise<Map<string, string[]>> {
  const ids = products.map((p) => p.id);
  const used = new Map<string, string[]>();
  if (ids.length === 0) return used;
  const byProduct = { distinct: ['productId' as const], select: { productId: true } };
  const byItem = { distinct: ['itemId' as const], select: { itemId: true } };
  const polymorphic = { itemType: PRODUCT, itemId: { in: ids } };
  const [
    movements,
    balances,
    purchaseItems,
    orderItems,
    fiscalItems,
    dispatchItems,
    productionOrders,
    reservations,
    quotationItems,
    quotationReservations,
  ] = await Promise.all([
    tx.inventoryMovement.findMany({ where: polymorphic, ...byItem }),
    tx.inventoryBalance.findMany({ where: polymorphic, ...byItem }),
    tx.purchaseItem.findMany({ where: { productId: { in: ids } }, ...byProduct }),
    tx.salesOrderItem.findMany({ where: { productId: { in: ids } }, ...byProduct }),
    tx.fiscalDocumentItem.findMany({ where: { productId: { in: ids } }, ...byProduct }),
    tx.dispatchItem.findMany({ where: { productId: { in: ids } }, ...byProduct }),
    tx.productionOrder.findMany({ where: { productId: { in: ids } }, ...byProduct }),
    tx.reservation.findMany({ where: polymorphic, ...byItem }),
    tx.quotationItem.findMany({
      where: { productId: { in: ids }, quotation: liveQuotation() },
      ...byProduct,
    }),
    tx.quotationReservation.findMany({
      where: { ...polymorphic, quotation: liveQuotation() },
      ...byItem,
    }),
  ]);
  const mark = (id: string | null, label: string) => {
    if (id === null) return;
    const labels = used.get(id) ?? [];
    if (!labels.includes(label)) labels.push(label);
    used.set(id, labels);
  };
  for (const r of movements) mark(r.itemId, 'kardex');
  for (const r of balances) mark(r.itemId, 'kardex');
  for (const r of purchaseItems) mark(r.productId, 'compras');
  for (const r of orderItems) mark(r.productId, 'pedidos');
  for (const r of fiscalItems) mark(r.productId, 'comprobantes');
  for (const r of dispatchItems) mark(r.productId, 'despachos');
  for (const r of productionOrders) mark(r.productId, 'órdenes de producción');
  for (const r of reservations) mark(r.itemId, 'reservas de pedido');
  for (const r of quotationItems) mark(r.productId, 'cotizaciones vigentes');
  for (const r of quotationReservations) mark(r.itemId, 'cotizaciones vigentes');

  const coilCandidates = products.filter((p) => !used.has(p.id) && isCoilSaleProduct(p));
  const pools = await Promise.all(
    coilCandidates.map(async (p) => ({ id: p.id, codes: await coilCodesEverInPool(tx, p) })),
  );
  for (const r of pools) if (r.codes.length > 0) mark(r.id, 'bobinas');
  return used;
}

/** El motivo que el diálogo muestra junto a los campos bloqueados. */
export function structureLockReason(labels: readonly string[]): string {
  return (
    `Tiene uso real (${labels.join(', ')}): su subtipo, espesor y color ya no cambian. ` +
    'Crea otro producto y desactiva este.'
  );
}
