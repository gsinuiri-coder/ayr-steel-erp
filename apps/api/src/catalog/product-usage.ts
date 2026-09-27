import { CoilKind, InventoryItemType, type BusinessLineCode, type Prisma } from '@prisma/client';
import { quotationCode, salesOrderCode, toFixedString } from '@ayr/shared';
import { attributeOf, coilPoolKeyOfProduct, isCoilSaleProduct } from '../sales/coil-sale-product';

/**
 * **Borrado físico de un producto que nunca se usó (D-347, M6).**
 *
 * «Uso» sigue el mismo criterio en las dos funciones de este archivo: cualquier fila que
 * referencie al producto desde un documento comercial, el kardex, una reserva o la producción
 * cuenta; el historial de precio de lista (`ProductListPriceChange`) y `audit_log` no, porque
 * son historia de **catálogo**, no de un hecho de negocio (decisión del dueño, D-347). Un
 * producto de venta de bobina (`BOB…`) no tiene FK propia hacia una bobina — se deduce del
 * pool por espesor/acabado (D-252) — así que su «uso» se resuelve aparte, con el mismo filtro
 * que ya protege su desactivación (`openCoilCodesInPool`, D-257), pero sin mirar saldo ni
 * estado: para «nunca se usó» importa que haya existido una bobina, no que le quede saldo.
 *
 * Ser el destino de una fusión (`Product.mergedFrom`, D-253) también cuenta: borrar el
 * principal dejaría el `mergedIntoId` de los productos unidos apuntando a un producto que ya
 * no existe — el mismo motivo por el que `sales_price_changes.productId` cuenta (decisión del
 * dueño): algo quedaría apuntando a un producto borrado.
 */

export interface ProductUsageIdentity {
  id: string;
  sku: string;
  businessLine: { code: BusinessLineCode };
}

const PRODUCT = InventoryItemType.PRODUCT;

/**
 * Los códigos de bobina (cualquier estado, cualquier saldo) que alguna vez resolvieron al pool
 * de este producto de venta de bobina. `[]` si no es uno (`isCoilSaleProduct`) o si nunca hubo
 * una bobina de su espesor/acabado.
 */
async function coilCodesEverInPool(
  tx: Prisma.TransactionClient,
  product: ProductUsageIdentity & { name: string },
): Promise<string[]> {
  const key = await coilPoolKeyOfProduct(tx, product);
  if (key === null) return [];
  const coils = await tx.coil.findMany({
    where: { kind: CoilKind.COIL, thicknessMm: toFixedString(key.thicknessMm, 'MM') },
    select: { code: true, finish: { select: { kind: true, color: { select: { code: true } } } } },
    orderBy: { code: 'asc' },
  });
  return coils.filter((c) => attributeOf(c.finish) === key.attribute).map((c) => c.code);
}

/**
 * El motivo, en español y listo para el 409 de `DELETE /catalog/:id`, de por qué **este**
 * producto no se puede borrar. `[]` = nunca se usó. Para un solo producto (el que se intenta
 * borrar): el costo de las ~13 consultas no importa, es una acción manual y deliberada.
 */
export async function describeProductUsage(
  tx: Prisma.TransactionClient,
  product: ProductUsageIdentity & { name: string },
): Promise<string[]> {
  const where = { productId: product.id };
  const [
    purchaseItems,
    boms,
    productionOrders,
    quotationItems,
    salesOrderItems,
    priceChanges,
    fiscalItems,
    dispatchItems,
    movements,
    reservations,
    quotationReservations,
    mergedFrom,
    coilCodes,
  ] = await Promise.all([
    tx.purchaseItem.count({ where }),
    tx.productBom.count({ where }),
    tx.productionOrder.count({ where }),
    tx.quotationItem.count({ where }),
    tx.salesOrderItem.count({ where }),
    tx.salesPriceChange.findMany({
      where,
      select: { quotation: { select: { seq: true } }, salesOrder: { select: { seq: true } } },
    }),
    tx.fiscalDocumentItem.count({ where }),
    tx.dispatchItem.count({ where }),
    tx.inventoryMovement.count({ where: { itemType: PRODUCT, itemId: product.id } }),
    tx.reservation.count({ where: { itemType: PRODUCT, itemId: product.id } }),
    tx.quotationReservation.count({ where: { itemType: PRODUCT, itemId: product.id } }),
    tx.product.count({ where: { mergedIntoId: product.id } }),
    isCoilSaleProduct(product) ? coilCodesEverInPool(tx, product) : Promise.resolve([]),
  ]);

  const reasons: string[] = [];
  if (purchaseItems > 0) reasons.push(`${String(purchaseItems)} línea(s) de compra`);
  if (boms > 0) reasons.push(`${String(boms)} receta(s) de producción (histórico, D-344)`);
  if (productionOrders > 0) reasons.push(`${String(productionOrders)} orden(es) de producción`);
  if (quotationItems > 0) reasons.push(`${String(quotationItems)} línea(s) de cotización`);
  if (salesOrderItems > 0) reasons.push(`${String(salesOrderItems)} línea(s) de pedido`);
  if (priceChanges.length > 0) {
    // Decisión del dueño (M6, Paso 0): cuenta como uso, y se nombra el documento — no un
    // conteo suelto — porque lo que de verdad importa es qué cotización o pedido quedaría con
    // su historial de precio apuntando a un producto que ya no existe.
    const codes = [
      ...new Set(
        priceChanges.flatMap((c) =>
          c.quotation
            ? [quotationCode(c.quotation.seq)]
            : c.salesOrder
              ? [salesOrderCode(c.salesOrder.seq)]
              : [],
        ),
      ),
    ];
    const shown = codes.slice(0, 3).join('/');
    reasons.push(`historial de cambios de precio de ${shown}${codes.length > 3 ? '…' : ''}`);
  }
  if (fiscalItems > 0) reasons.push(`${String(fiscalItems)} línea(s) de comprobante`);
  if (dispatchItems > 0) reasons.push(`${String(dispatchItems)} línea(s) de despacho`);
  if (movements > 0) reasons.push(`${String(movements)} movimiento(s) de kardex`);
  if (reservations > 0) reasons.push(`${String(reservations)} reserva(s) de pedido`);
  if (quotationReservations > 0) {
    reasons.push(`${String(quotationReservations)} reserva(s) temporal(es) de cotización`);
  }
  if (mergedFrom > 0) {
    reasons.push(`es el destino de la unión de ${String(mergedFrom)} producto(s) (D-253)`);
  }
  if (coilCodes.length > 0) {
    const shown = coilCodes.slice(0, 3).join(', ');
    reasons.push(
      `${String(coilCodes.length)} bobina(s) de su pool (${shown}${coilCodes.length > 3 ? '…' : ''})`,
    );
  }
  return reasons;
}

/**
 * `canDelete` de una tanda de productos (el catálogo entero, o una línea): las doce tablas de
 * uso se consultan agrupadas, una vez cada una — nunca una por producto —, el presupuesto que
 * exige AGENTS §3.4 para cualquier dato agregado. **El pool de bobinas es la excepción**: no
 * hay forma de agrupar «¿tiene coincidencia en el pool?» en una sola consulta para varios
 * `BOB…` a la vez (cada uno resuelve un espesor/acabado distinto), así que agrega dos consultas
 * más **por cada `BOB…` que ninguna otra tabla ya marcó usado** (autorrevisión) — acotado en la
 * práctica al puñado de SKU de reventa de bobina del catálogo, nunca a filas de otro tipo.
 * Devuelve el conjunto de ids **usados**; el resto se puede borrar.
 */
export async function productsWithUsage(
  tx: Prisma.TransactionClient,
  products: readonly (ProductUsageIdentity & { name: string })[],
): Promise<Set<string>> {
  const ids = products.map((p) => p.id);
  if (ids.length === 0) return new Set();
  const used = new Set<string>();
  const distinctProductId = { distinct: ['productId' as const], select: { productId: true } };
  const [
    purchaseItems,
    boms,
    productionOrders,
    quotationItems,
    salesOrderItems,
    priceChanges,
    fiscalItems,
    dispatchItems,
    movements,
    reservations,
    quotationReservations,
    mergedFrom,
  ] = await Promise.all([
    tx.purchaseItem.findMany({ where: { productId: { in: ids } }, ...distinctProductId }),
    tx.productBom.findMany({ where: { productId: { in: ids } }, ...distinctProductId }),
    tx.productionOrder.findMany({ where: { productId: { in: ids } }, ...distinctProductId }),
    tx.quotationItem.findMany({ where: { productId: { in: ids } }, ...distinctProductId }),
    tx.salesOrderItem.findMany({ where: { productId: { in: ids } }, ...distinctProductId }),
    tx.salesPriceChange.findMany({ where: { productId: { in: ids } }, ...distinctProductId }),
    tx.fiscalDocumentItem.findMany({ where: { productId: { in: ids } }, ...distinctProductId }),
    tx.dispatchItem.findMany({ where: { productId: { in: ids } }, ...distinctProductId }),
    tx.inventoryMovement.findMany({
      where: { itemType: PRODUCT, itemId: { in: ids } },
      distinct: ['itemId'],
      select: { itemId: true },
    }),
    tx.reservation.findMany({
      where: { itemType: PRODUCT, itemId: { in: ids } },
      distinct: ['itemId'],
      select: { itemId: true },
    }),
    tx.quotationReservation.findMany({
      where: { itemType: PRODUCT, itemId: { in: ids } },
      distinct: ['itemId'],
      select: { itemId: true },
    }),
    tx.product.findMany({
      where: { mergedIntoId: { in: ids } },
      distinct: ['mergedIntoId'],
      select: { mergedIntoId: true },
    }),
  ]);
  for (const row of purchaseItems) if (row.productId) used.add(row.productId);
  for (const row of boms) used.add(row.productId);
  for (const row of productionOrders) used.add(row.productId);
  for (const row of quotationItems) used.add(row.productId);
  for (const row of salesOrderItems) used.add(row.productId);
  for (const row of priceChanges) used.add(row.productId);
  for (const row of fiscalItems) if (row.productId) used.add(row.productId);
  for (const row of dispatchItems) used.add(row.productId);
  for (const row of movements) used.add(row.itemId);
  for (const row of reservations) used.add(row.itemId);
  for (const row of quotationReservations) used.add(row.itemId);
  for (const row of mergedFrom) if (row.mergedIntoId) used.add(row.mergedIntoId);

  // El pool de bobinas solo se mira para los `BOB…` que ninguna otra tabla ya marcó usados —
  // acotado al puñado real de productos de venta de bobina del catálogo, nunca por fila.
  const coilCandidates = products.filter((p) => !used.has(p.id) && isCoilSaleProduct(p));
  if (coilCandidates.length > 0) {
    const results = await Promise.all(
      coilCandidates.map(async (p) => ({ id: p.id, codes: await coilCodesEverInPool(tx, p) })),
    );
    for (const r of results) if (r.codes.length > 0) used.add(r.id);
  }
  return used;
}
