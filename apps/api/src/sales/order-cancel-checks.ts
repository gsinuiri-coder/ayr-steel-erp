import {
  DispatchStatus,
  FiscalDocType,
  FiscalDocumentOrigin,
  FiscalDocumentStatus,
  InventoryItemType,
  InventoryMovementType,
  InventoryRefType,
  ProductionOrderStatus,
  ProductionReportStatus,
  type Prisma,
} from '@prisma/client';
import {
  Decimal,
  LIVE_DOCUMENT_STATUSES,
  businessToday,
  dispatchCode,
  productionOrderCode,
  toDecimal,
  type FabricatedLooseLineDto,
} from '@ayr/shared';
import { invoicedByOrderItem } from '../invoicing/invoicing-net';
import { isMadeToOrder } from './sales-lines';

/**
 * D-383: lo que hay que mirar antes de anular un pedido, compartido por la anulación (con sus
 * locks) y por la vista previa del diálogo (sin locks).
 *
 * Nació de dos casos: FFA1-00001389, que quedó vivo sobre un pedido anulado (D-381), y la lectura
 * de código del 2026-10-03, que mostró que anular con OPs cerradas deja lo fabricado en
 * inventario sin pedido y sin aviso.
 */

/** Factura y boleta: lo que factura las líneas del pedido. */
const SALE_DOC_TYPES: readonly FiscalDocType[] = [FiscalDocType.FACTURA, FiscalDocType.BOLETA];

const DOC_TYPE_LABEL: Record<FiscalDocType, string> = {
  [FiscalDocType.FACTURA]: 'factura',
  [FiscalDocType.BOLETA]: 'boleta',
  [FiscalDocType.NOTA_CREDITO]: 'nota de crédito',
  [FiscalDocType.GUIA_REMISION_REMITENTE]: 'guía de remisión',
};

/** El día de negocio (Lima) de un instante, como `03/10/2026`. */
function dayLabel(at: Date): string {
  const [y, m, d] = businessToday(at).split('-');
  return `${d ?? ''}/${m ?? ''}/${y ?? ''}`;
}

/**
 * Los bloqueos comerciales: un comprobante vivo que factura el pedido (por cabecera o por línea)
 * y los despachos vigentes. Mensajes listos para el usuario, en el orden en que hay que
 * resolverlos.
 */
export async function commercialCancelBlocks(
  db: Prisma.TransactionClient,
  orderId: string,
  orderCode: string,
): Promise<string[]> {
  const itemIds = (
    await db.salesOrderItem.findMany({ where: { salesOrderId: orderId }, select: { id: true } })
  ).map((i) => i.id);
  const [candidates, dispatches] = await Promise.all([
    // Facturas y boletas vivas y en borrador, en una sola consulta. Las notas de crédito en
    // borrador no bloquean: no facturan nada, y el mostrador puede dejar una a medias entre
    // crearla y emitirla (autorrevisión de D-383, P3).
    db.fiscalDocument.findMany({
      where: {
        docType: { in: [...SALE_DOC_TYPES] },
        status: { in: [...LIVE_DOCUMENT_STATUSES, FiscalDocumentStatus.DRAFT] },
        archivedAt: null,
        OR: [{ salesOrderId: orderId }, { items: { some: { salesOrderItemId: { in: itemIds } } } }],
      },
      select: {
        number: true,
        docType: true,
        status: true,
        createdAt: true,
        origin: true,
        totalPen: true,
        creditNotes: {
          where: { status: { in: [...LIVE_DOCUMENT_STATUSES] }, archivedAt: null },
          select: { totalPen: true },
        },
        // ¿Factura alguna línea del pedido, o solo cuelga de la cabecera?
        items: {
          where: { salesOrderItemId: { in: itemIds } },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { number: 'asc' },
    }),
    db.dispatch.findMany({
      where: { salesOrderId: orderId, status: DispatchStatus.ISSUED },
      select: { seq: true },
      orderBy: { seq: 'asc' },
    }),
  ]);
  // Un comprobante acreditado por completo con notas de crédito vivas ya no factura nada: la
  // venta está deshecha por ese camino. Es lo que hace el mostrador al anular una boleta fuera
  // del plazo de baja (`PosService.void`: nota de crédito total y después `cancel`), y no se
  // bloquea.
  //
  // El criterio es el **neto por línea** de D-346 (`invoicedByOrderItem`: lo facturado vivo menos
  // lo acreditado vivo, por cantidad): si ninguna línea del pedido queda facturada, la venta está
  // deshecha aunque el total del papel difiera en céntimos de la suma de sus líneas (autorrevisión
  // de D-383, P2). Solo un comprobante que no factura ninguna línea —cuelga de la cabecera— se mide
  // por importe, al céntimo.
  const live = candidates.filter((d) => d.status !== FiscalDocumentStatus.DRAFT);
  const notFullyCredited = (d: (typeof live)[number]) => {
    const credited = d.creditNotes.reduce<Decimal>(
      (acc, n) => acc.plus(toDecimal(n.totalPen.toString())),
      new Decimal(0),
    );
    return credited.toDecimalPlaces(2).lt(toDecimal(d.totalPen.toString()).toDecimalPlaces(2));
  };
  let docs: typeof live = [];
  if (live.length > 0) {
    const net = await invoicedByOrderItem(db, itemIds);
    const stillInvoiced = [...net.values()].some((n) => n.qty.gt(0));
    const byLine = live.filter((d) => d.items.length > 0);
    const headerOnly = live.filter((d) => d.items.length === 0 && notFullyCredited(d));
    docs = [
      ...(stillInvoiced
        ? byLine.filter(notFullyCredited).length > 0
          ? byLine.filter(notFullyCredited)
          : byLine
        : []),
      ...headerOnly,
    ];
  }
  const blocks: string[] = [];
  if (docs.length > 0) {
    const numbers = docs.map((d) => d.number ?? 'sin número').join(', ');
    const how = docs.every((d) => d.origin !== FiscalDocumentOrigin.ISSUED_HERE)
      ? 'anúlalo internamente'
      : 'anúlalo (un manual, internamente; uno emitido por el ERP, con baja o nota de crédito)';
    blocks.push(
      `El pedido ${orderCode} tiene ${docs.length === 1 ? 'el comprobante' : 'los comprobantes'} ${numbers} vigente${docs.length === 1 ? '' : 's'}: ${how} antes de anular el pedido`,
    );
  }
  // Decisión del dueño (revisión del PR #90): un borrador también bloquea, nombrándolo. Sin
  // borrado automático: el borrador puede ser el intento de reingreso de un papel vigente.
  const drafts = candidates.filter((d) => d.status === FiscalDocumentStatus.DRAFT);
  if (drafts.length > 0) {
    const named = drafts
      .map(
        (d) =>
          `${DOC_TYPE_LABEL[d.docType]} del ${dayLabel(d.createdAt)} por S/ ${toDecimal(d.totalPen.toString()).toFixed(2)}`,
      )
      .join('; ');
    blocks.push(
      `El pedido ${orderCode} tiene ${drafts.length === 1 ? 'un borrador de comprobante' : `${String(drafts.length)} borradores de comprobante`}: elimina primero ${drafts.length === 1 ? 'el borrador' : 'los borradores'} (${named}) antes de anular el pedido`,
    );
  }
  if (dispatches.length > 0) {
    blocks.push(
      `El pedido ${orderCode} tiene ${dispatches.length === 1 ? 'el despacho' : 'los despachos'} ${dispatches.map((d) => dispatchCode(d.seq)).join(', ')} vigente${dispatches.length === 1 ? '' : 's'}: ${dispatches.length === 1 ? 'reviértelo' : 'reviértelos'} antes de anular el pedido`,
    );
  }
  return blocks;
}

/**
 * Para la vista previa: la OP que hoy bloquea la anulación (en curso, o en borrador con un
 * reporte activo). La anulación lo comprueba por su cuenta, con lock, y cancela las OP en
 * borrador sin reportes (D-186).
 */
export async function productionCancelBlock(
  db: Prisma.TransactionClient,
  orderId: string,
): Promise<string | null> {
  const live = await db.productionOrder.findMany({
    where: {
      reservation: { salesOrderId: orderId },
      OR: [
        { status: ProductionOrderStatus.IN_PROGRESS },
        {
          status: ProductionOrderStatus.DRAFT,
          reports: { some: { status: ProductionReportStatus.ACTIVE } },
        },
      ],
    },
    select: { seq: true },
    orderBy: { seq: 'asc' },
  });
  if (live.length === 0) return null;
  const detail = live.map((op) => `orden ${productionOrderCode(op.seq)}`).join(', ');
  return `No se puede anular: ${detail} está fabricando con el material reservado. Anula la orden de producción primero.`;
}

/**
 * El producto fabricado contra cada línea del pedido que todavía no salió: lo fabricado vivo
 * (ingresos de producción de reportes vigentes no revertidos, el mismo criterio que
 * `fabricatedAliveQty` de D-379) menos lo despachado vigente de esa línea y ese producto.
 *
 * Al anular el pedido, su reserva se libera y ese stock queda sin pedido: una línea a pedido
 * reserva bobina y nunca producto, el despacho exige la reserva de la propia línea y el
 * mostrador excluye coberturas y metros, así que nadie lo toma.
 *
 * Cuatro consultas para todo el pedido, sin importar cuántas líneas ni reportes tenga.
 */
export async function fabricatedLooseLines(
  db: Prisma.TransactionClient,
  orderId: string,
): Promise<FabricatedLooseLineDto[]> {
  const reports = await db.productionReport.findMany({
    where: {
      status: ProductionReportStatus.ACTIVE,
      productionOrder: { reservation: { salesOrderId: orderId } },
    },
    select: {
      id: true,
      productionOrder: {
        select: { seq: true, status: true, reservation: { select: { salesOrderItemId: true } } },
      },
    },
  });
  if (reports.length === 0) return [];
  const itemOfReport = new Map<string, string>();
  const opsOfItem = new Map<string, Map<string, string>>();
  for (const r of reports) {
    const itemId = r.productionOrder.reservation?.salesOrderItemId;
    if (!itemId) continue;
    itemOfReport.set(r.id, itemId);
    const ops = opsOfItem.get(itemId) ?? new Map<string, string>();
    ops.set(productionOrderCode(r.productionOrder.seq), r.productionOrder.status);
    opsOfItem.set(itemId, ops);
  }
  const itemIds = [...opsOfItem.keys()];
  const [items, entries, dispatched] = await Promise.all([
    db.salesOrderItem.findMany({
      where: { id: { in: itemIds } },
      select: {
        id: true,
        lineNumber: true,
        productId: true,
        description: true,
        product: { select: { sku: true, unit: true, roofingKind: true, lengthMm: true } },
      },
    }),
    db.inventoryMovement.findMany({
      where: {
        type: InventoryMovementType.IN,
        refType: InventoryRefType.PRODUCTION,
        itemType: InventoryItemType.PRODUCT,
        refId: { in: [...itemOfReport.keys()] },
        reversals: { none: {} },
      },
      select: { refId: true, itemId: true, qty: true },
    }),
    db.dispatchItem.groupBy({
      by: ['salesOrderItemId', 'itemId'],
      where: {
        salesOrderItemId: { in: itemIds },
        itemType: InventoryItemType.PRODUCT,
        dispatch: { status: DispatchStatus.ISSUED },
      },
      _sum: { reserveQty: true },
    }),
  ]);

  const out: FabricatedLooseLineDto[] = [];
  for (const item of [...items].sort((a, b) => a.lineNumber - b.lineNumber)) {
    // Solo los ingresos del producto que la línea vende hoy, como `fabricatedAliveQty`.
    const made = entries
      .filter((m) => m.refId !== null && itemOfReport.get(m.refId) === item.id)
      .filter((m) => m.itemId === item.productId)
      .reduce<Decimal>((acc, m) => acc.plus(toDecimal(m.qty.toString())), new Decimal(0));
    const shipped = dispatched
      .filter((d) => d.salesOrderItemId === item.id && d.itemId === item.productId)
      .reduce<Decimal>(
        (acc, d) => acc.plus(toDecimal((d._sum.reserveQty ?? 0).toString())),
        new Decimal(0),
      );
    const loose = made.minus(shipped);
    if (!loose.gt(0)) continue;
    out.push({
      salesOrderItemId: item.id,
      lineNumber: item.lineNumber,
      sku: item.product.sku,
      description: item.description,
      qty: loose.toFixed(3),
      unit: item.product.unit,
      madeToOrder: isMadeToOrder(item.product),
      productionOrders: [...(opsOfItem.get(item.id) ?? new Map<string, string>()).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([code, status]) => ({ code, status })),
    });
  }
  return out;
}

/** Los comprobantes manuales anulados del pedido (para el aviso del diálogo). */
export async function annulledManualDocuments(
  db: Prisma.TransactionClient,
  orderId: string,
): Promise<{ id: string; number: string | null }[]> {
  return db.fiscalDocument.findMany({
    where: {
      salesOrderId: orderId,
      status: FiscalDocumentStatus.ANNULLED,
      origin: FiscalDocumentOrigin.MANUAL,
      docType: { in: [...SALE_DOC_TYPES] },
      archivedAt: null,
    },
    select: { id: true, number: true },
    orderBy: { number: 'asc' },
  });
}

/** El texto del rechazo cuando falta la casilla, con lo que queda suelto por línea. */
export function fabricatedNeedsAcknowledgement(
  orderCode: string,
  lines: readonly FabricatedLooseLineDto[],
): string {
  const detail = lines
    .map(
      (l) =>
        `línea ${String(l.lineNumber)} ${l.sku}: ${toDecimal(l.qty).toString()} ${l.unit} (${l.productionOrders.map((o) => o.code).join(', ')})`,
    )
    .join('; ');
  const loose = lines.some((l) => l.madeToOrder)
    ? ' Lo fabricado contra pedido no lo toma ningún otro pedido ni el mostrador hasta revertir la producción.'
    : '';
  return `El pedido ${orderCode} tiene producto fabricado sin despachar (${detail}). Al anularlo queda en inventario sin pedido.${loose} Confirma que lo entiendes para anular`;
}
