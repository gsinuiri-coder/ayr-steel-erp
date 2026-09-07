/**
 * Borra FÍSICAMENTE los comprobantes importados (RF-71, `origin = IMPORTED`) y todo lo que
 * cuelga de ellos: su CxC (cobros), sus pedidos enlazados —cáscara (D-141) o vivos—, las
 * reservas de esos pedidos y las OP en cola que esos pedidos abrieron, si nunca tocaron
 * nada.
 *
 * Existe porque D-110 solo le dio a un importado una baja **interna** (`ANNULLED`, la fila
 * queda): correcto para el día a día, pero un ensayo de importación con datos de prueba deja
 * comprobantes, pedidos y reservas que no se van a volver a tocar y que ninguna reversa de
 * dominio borra. Esto es un bisturí para esa sola situación — nunca la baja de un importado
 * real, que sigue siendo `annul` (D-110).
 *
 * GUARDAS DURAS — si cualquiera dispara, se aborta TODO sin borrar nada y se imprime el
 * detalle:
 *   1. una OP enlazada no está en DRAFT ni CANCELLED (montada, en curso o cerrada). Una
 *      CANCELLED entra en el conjunto solo si además pasa las guardas 2 y 3 — cancelada
 *      directo desde DRAFT, sin haber tocado nunca una bobina.
 *   2. una OP enlazada tiene o tuvo una bobina montada (`production_order_consumptions`),
 *      aunque ya esté liberada.
 *   3. una OP enlazada tiene un reporte de piezas (no debería existir en DRAFT ni en una
 *      CANCELLED sin bobina; se comprueba igual).
 *   4. existe un despacho de alguno de los pedidos del conjunto.
 *   5. existe un movimiento de kardex que referencie un despacho o una OP del conjunto.
 *   6. un documento **fuera** del conjunto (una nota de crédito emitida acá, una corrección,
 *      una reimportación) referencia a uno del conjunto — ese documento externo se quedaría
 *      con una referencia rota.
 *   7. (invariante) algún pedido enlazado a un documento del conjunto no es él mismo
 *      `origin = IMPORTED`.
 *
 * Dry-run por defecto: solo reporta qué borraría, tabla por tabla. `--execute` lo hace de
 * verdad, en una sola transacción — o borra el conjunto entero o no borra nada.
 *
 * NO toca bobinas, compras, catálogo, clientes, proveedores, colores/acabados, kardex ni
 * pedidos que no sean `origin = IMPORTED`.
 *
 * Uso: `node scripts/prod-purge-imported-sales.mjs [--branch <rama>] [--execute]`
 */
import {
  PrismaClient,
  SalesOrderOrigin,
  ProductionOrderStatus,
  InventoryRefType,
} from '@prisma/client';

const prisma = new PrismaClient();
const execute = process.argv.includes('--execute');

interface Blocker {
  reason: string;
}

async function main(): Promise<void> {
  console.warn(`Purga de comprobantes importados${execute ? ' (EJECUTANDO)' : ' (simulación)'}`);

  // 1) El conjunto de comprobantes: todo `origin = IMPORTED`, versión vigente y archivada
  //    (RF-72 encadena una reimportación con `supersedesDocumentId`, y las dos puntas son
  //    siempre importadas).
  const documents = await prisma.fiscalDocument.findMany({
    where: { origin: SalesOrderOrigin.IMPORTED },
    select: {
      id: true,
      number: true,
      docType: true,
      status: true,
      salesOrderId: true,
      affectedDocumentId: true,
      replacesDocumentId: true,
      supersedesDocumentId: true,
    },
  });
  if (documents.length === 0) {
    console.warn('No hay comprobantes importados. Nada que borrar.');
    return;
  }
  const docIds = documents.map((d) => d.id);
  console.warn(`Comprobantes importados: ${documents.length}`);

  const blockers: Blocker[] = [];

  // Guarda 6: nada fuera del conjunto puede referenciar a uno del conjunto.
  const externalRefs = await prisma.fiscalDocument.findMany({
    where: {
      OR: [
        { affectedDocumentId: { in: docIds } },
        { replacesDocumentId: { in: docIds } },
        { supersedesDocumentId: { in: docIds } },
      ],
      id: { notIn: docIds },
    },
    select: { id: true, number: true, docType: true, origin: true },
  });
  for (const ref of externalRefs) {
    blockers.push({
      reason:
        `el documento ${ref.number ?? ref.id} (${ref.docType}, origin=${ref.origin}) ` +
        'referencia a uno del conjunto y no es él mismo importado',
    });
  }

  // 2) Pedidos enlazados: los que cuelgan de esos comprobantes (D-141 es 1:1).
  const orderIdsFromDocs = [
    ...new Set(documents.map((d) => d.salesOrderId).filter((id): id is string => id !== null)),
  ];
  const orders = await prisma.salesOrder.findMany({
    where: { id: { in: orderIdsFromDocs } },
    select: { id: true, seq: true, status: true, origin: true },
  });
  const orderIds = orders.map((o) => o.id);
  console.warn(`Pedidos enlazados: ${orders.length}`);

  // Guarda 7 (invariante): un pedido enlazado a un importado tiene que ser él mismo importado.
  for (const order of orders) {
    if (order.origin !== SalesOrderOrigin.IMPORTED) {
      blockers.push({
        reason: `el pedido ${order.seq} está enlazado a un comprobante importado pero su origen es ${order.origin}`,
      });
    }
  }

  // Guarda 4: ningún pedido del conjunto tiene un despacho — vivo o revertido, da igual: un
  // despacho es mercadería que de verdad salió del almacén.
  const dispatches = await prisma.dispatch.findMany({
    where: { salesOrderId: { in: orderIds } },
    select: { id: true, seq: true, salesOrderId: true },
  });
  for (const dispatch of dispatches) {
    blockers.push({
      reason: `el pedido tiene el despacho ${dispatch.seq}`,
    });
  }

  // 3) Reservas de esos pedidos (genéricas de materia prima y de producto terminado, D-088).
  const reservations = await prisma.reservation.findMany({
    where: { salesOrderId: { in: orderIds } },
    select: { id: true },
  });
  const reservationIds = reservations.map((r) => r.id);
  console.warn(`Reservas: ${reservations.length}`);

  // 4) OP enlazadas a esas reservas.
  const productionOrders = await prisma.productionOrder.findMany({
    where: { reservationId: { in: reservationIds } },
    select: { id: true, seq: true, status: true, kind: true },
  });
  const opIds = productionOrders.map((o) => o.id);
  console.warn(`Órdenes de producción enlazadas: ${productionOrders.length}`);

  // Guarda 1: DRAFT o CANCELLED. Una CANCELLED entra igual — la descarta la guarda 2/3 si
  // tuvo bobina montada o reporte alguna vez; si nunca los tuvo, cancelarse desde DRAFT no
  // dejó ningún efecto de inventario y es tan borrable como si siguiera en cola.
  const acceptedOpStatus: ProductionOrderStatus[] = [
    ProductionOrderStatus.DRAFT,
    ProductionOrderStatus.CANCELLED,
  ];
  for (const op of productionOrders) {
    if (!acceptedOpStatus.includes(op.status)) {
      blockers.push({
        reason: `la OP ${op.seq} está ${op.status}, no DRAFT ni CANCELLED`,
      });
    }
  }

  // Guarda 2: sin bobina montada, nunca — ni liberada después.
  const consumptions = await prisma.productionOrderConsumption.findMany({
    where: { productionOrderId: { in: opIds } },
    select: { id: true, productionOrderId: true },
  });
  const opsByIdForLog = new Map(productionOrders.map((o) => [o.id, o.seq]));
  for (const consumption of consumptions) {
    blockers.push({
      reason: `la OP ${opsByIdForLog.get(consumption.productionOrderId) ?? consumption.productionOrderId} tiene (o tuvo) una bobina montada`,
    });
  }

  // Guarda 3: sin reportes de piezas (no debería pasar en DRAFT; se comprueba igual).
  const reports = await prisma.productionReport.findMany({
    where: { productionOrderId: { in: opIds } },
    select: { id: true, productionOrderId: true },
  });
  for (const report of reports) {
    blockers.push({
      reason: `la OP ${opsByIdForLog.get(report.productionOrderId) ?? report.productionOrderId} tiene un reporte de piezas`,
    });
  }

  // Guarda 5: ningún movimiento de kardex referencia un despacho o una OP del conjunto.
  // `refId` es VARCHAR sin FK (el kardex referencia entidades de varios módulos), así que la
  // búsqueda va por id, no por relación. Los despachos ya se comprobaron arriba (guarda 4);
  // esto cubre además el caso de una OP cerrada que dejó merma (`refType SCRAP`, `refId`
  // el propio id de la OP) — que la guarda 1 ya debería haber atrapado, pero se confirma.
  const refIds = [...dispatches.map((d) => d.id), ...opIds];
  const movements =
    refIds.length === 0
      ? []
      : await prisma.inventoryMovement.findMany({
          where: {
            refType: {
              in: [InventoryRefType.SALE, InventoryRefType.PRODUCTION, InventoryRefType.SCRAP],
            },
            refId: { in: refIds },
          },
          select: { id: true, refType: true, refId: true },
        });
  for (const movement of movements) {
    blockers.push({
      reason: `hay un movimiento de kardex (${movement.refType}, id ${movement.id}) que referencia ${movement.refId}`,
    });
  }

  if (blockers.length > 0) {
    console.error('');
    console.error(`BLOQUEADO — ${blockers.length} motivo(s), no se borró nada:`);
    for (const blocker of blockers) console.error(`  - ${blocker.reason}`);
    process.exitCode = 1;
    return;
  }

  console.warn('');
  console.warn('Sin bloqueos. Conjunto a borrar:');
  console.warn(`  comprobantes: ${documents.length}`);
  console.warn(`  pedidos: ${orders.length}`);
  console.warn(`  reservas: ${reservations.length}`);
  console.warn(`  órdenes de producción: ${productionOrders.length}`);

  if (!execute) {
    console.warn('');
    console.warn('Simulación: nada se borró. Repetí con --execute para borrar de verdad.');
    return;
  }

  const counts = await prisma.$transaction(async (tx) => {
    // OP y lo que cuelga de ella, del hijo al padre.
    const reportsDeleted = await tx.productionReport.deleteMany({
      where: { productionOrderId: { in: opIds } },
    });
    const consumptionsDeleted = await tx.productionOrderConsumption.deleteMany({
      where: { productionOrderId: { in: opIds } },
    });
    const opItemsDeleted = await tx.productionOrderItem.deleteMany({
      where: { productionOrderId: { in: opIds } },
    });
    const opsDeleted = await tx.productionOrder.deleteMany({ where: { id: { in: opIds } } });

    // Comprobantes y su CxC. Antes de los pedidos: `fiscal_documents.sales_order_id` no
    // tiene cascada.
    const docItemsDeleted = await tx.fiscalDocumentItem.deleteMany({
      where: { documentId: { in: docIds } },
    });
    const paymentsDeleted = await tx.customerPayment.deleteMany({
      where: { documentId: { in: docIds } },
    });
    const documentsDeleted = await tx.fiscalDocument.deleteMany({ where: { id: { in: docIds } } });

    // Reservas: después de las OP (`production_orders.reservation_id` no tiene cascada).
    const reservationsDeleted = await tx.reservation.deleteMany({
      where: { salesOrderId: { in: orderIds } },
    });

    // Pedidos: después de sus comprobantes y de sus reservas.
    const orderPiecesDeleted = await tx.salesOrderItemPiece.deleteMany({
      where: { salesOrderItem: { salesOrderId: { in: orderIds } } },
    });
    const orderItemsDeleted = await tx.salesOrderItem.deleteMany({
      where: { salesOrderId: { in: orderIds } },
    });
    const ordersDeleted = await tx.salesOrder.deleteMany({ where: { id: { in: orderIds } } });

    return {
      reportsDeleted: reportsDeleted.count,
      consumptionsDeleted: consumptionsDeleted.count,
      opItemsDeleted: opItemsDeleted.count,
      opsDeleted: opsDeleted.count,
      docItemsDeleted: docItemsDeleted.count,
      paymentsDeleted: paymentsDeleted.count,
      documentsDeleted: documentsDeleted.count,
      reservationsDeleted: reservationsDeleted.count,
      orderPiecesDeleted: orderPiecesDeleted.count,
      orderItemsDeleted: orderItemsDeleted.count,
      ordersDeleted: ordersDeleted.count,
    };
  });

  console.warn('');
  console.warn('Borrado. Conteos por tabla:');
  console.warn(`  production_reports: ${counts.reportsDeleted}`);
  console.warn(`  production_order_consumptions: ${counts.consumptionsDeleted}`);
  console.warn(`  production_order_items: ${counts.opItemsDeleted}`);
  console.warn(`  production_orders: ${counts.opsDeleted}`);
  console.warn(`  fiscal_document_items: ${counts.docItemsDeleted}`);
  console.warn(`  customer_payments: ${counts.paymentsDeleted}`);
  console.warn(`  fiscal_documents: ${counts.documentsDeleted}`);
  console.warn(`  reservations: ${counts.reservationsDeleted}`);
  console.warn(`  sales_order_item_pieces: ${counts.orderPiecesDeleted}`);
  console.warn(`  sales_order_items: ${counts.orderItemsDeleted}`);
  console.warn(`  sales_orders: ${counts.ordersDeleted}`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
