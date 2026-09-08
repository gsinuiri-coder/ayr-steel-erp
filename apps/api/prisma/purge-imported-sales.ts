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
 *
 * `--batch=<id>` (D-142): la misma herramienta, acotada a **un solo lote** del CLI de
 * importación de ventas (`import_batch_id`) en vez de a todo `origin = IMPORTED`. Es la
 * reversa de una corrida puntual —el dueño se equivocó en una decisión, quiere rehacerla—
 * y no un bisturí para el histórico entero. Guardas propias, además de las de arriba:
 *
 *   8. una OP del lote (en cola **o a stock**, D-140) no está en DRAFT/CANCELLED-sin-montar
 *      — misma guarda 1/2/3, extendida a la OP a stock que no cuelga de ninguna reserva.
 *   9. un cliente o un SKU que el lote creó (`import_batch_id`) pero que **algo fuera del
 *      lote** ya usó (otro pedido, otro comprobante, un movimiento de kardex) se **conserva**
 *      y se reporta — solo se borra si nada de afuera lo tocó.
 *
 * Uso: `node scripts/prod-purge-imported-sales.mjs --batch=<uuid> [--branch <rama>] [--execute]`
 *
 * `--exclude-touched` (D-142-ii): un lote de ensayo puede haber llegado a montar bobinas
 * reales y reportar planchas reales antes de que el dueño decidiera revertirlo — la reversa
 * de dominio (revertir reporte, anular OP) deja todo consistente, pero la OP **sigue**
 * disparando la guarda 8/2/3 porque el hecho de haber montado una bobina alguna vez es
 * unconditional (`aunque ya esté liberada`, ver arriba) y no se borra nunca. Sin este flag,
 * eso sigue abortando el lote entero, como siempre. Con él: el pedido **entero** que posee
 * esa OP (vía su reserva) —y su comprobante 1:1— se **excluye** del borrado físico en vez de
 * abortar todo; el resto del lote se purga igual. Un pedido excluido no se toca de ninguna
 * forma (no se anula, no se edita): sigue existiendo tal cual, para que quien lo audite vea
 * la OP cancelada y sus reportes revertidos en su lugar. Si una OP tocada no cuelga de
 * ninguna reserva (la OP a stock del déficit consolidado, D-140), no hay pedido al que
 * atribuirle la exclusión — ese caso sigue abortando el lote entero incluso con el flag.
 *
 * `--include-reverted` (D-143, necesita `--exclude-touched`): de los pedidos que
 * `--exclude-touched` acaba de excluir, promueve al borrado físico los que la reversa **de
 * dominio** ya dejó completamente inertes. No afloja la guarda del historial de montaje —la
 * verifica— exigiendo las cinco condiciones a la vez, releyendo el propio kardex en vez de
 * confiar en `production_reports.status`:
 *   1. el pedido está `CANCELLED` (`SalesOrdersService.cancel`, no un `DELETE`).
 *   2. su(s) comprobante(s) ya no viven: `ANNULLED` (D-110, importado) o `VOIDED`/`REJECTED` —
 *      nunca `ACCEPTED`/`DRAFT`/`SEND_ERROR`/`VOID_PENDING`/`ISSUED`.
 *   3. todas sus reservas están `RELEASED` (ninguna `ACTIVE`).
 *   4. toda OP que tocó producción real está `CANCELLED`.
 *   5. **cada movimiento de kardex** (`refType PRODUCTION/SCRAP`, `refId` = un reporte de esa
 *      OP) que no sea ya una reversa tiene su propia reversa presente — el hecho histórico de
 *      haber montado la bobina se queda (nunca se borra el movimiento), pero su efecto neto
 *      sobre el saldo tiene que ser cero.
 * Un pedido que falla cualquiera de las cinco se queda excluido, con el motivo impreso — sin
 * forzar nada.
 */
import {
  PrismaClient,
  SalesOrderOrigin,
  SalesOrderStatus,
  ProductionOrderStatus,
  ReservationStatus,
  FiscalDocumentStatus,
  InventoryRefType,
} from '@prisma/client';

const prisma = new PrismaClient();
const execute = process.argv.includes('--execute');
const batchArg = process.argv.find((a) => a.startsWith('--batch='))?.slice('--batch='.length);
const excludeTouched = process.argv.includes('--exclude-touched');
const includeReverted = process.argv.includes('--include-reverted');
if (includeReverted && !excludeTouched) {
  throw new Error(
    '--include-reverted necesita --exclude-touched: decide primero qué se excluye por haber ' +
      'tocado producción real, y --include-reverted decide después cuál de eso ya se revirtió ' +
      'por completo y se puede purgar igual.',
  );
}

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

/**
 * D-142: la reversa de **un solo lote** del CLI de importación de ventas. Ver el comentario
 * de cabecera para las dos guardas que se agregan a las siete de `main()`.
 */
async function purgeBatch(batchId: string): Promise<void> {
  console.warn(`Purga del lote ${batchId}${execute ? ' (EJECUTANDO)' : ' (simulación)'}`);

  const documents = await prisma.fiscalDocument.findMany({
    where: { importBatchId: batchId },
    select: { id: true, number: true, salesOrderId: true, status: true },
  });
  if (documents.length === 0) {
    console.warn(
      `El lote ${batchId} no tiene comprobantes (¿ya se purgó, o nunca confirmó nada?).`,
    );
    return;
  }
  const docIds = documents.map((d) => d.id);
  console.warn(`Comprobantes del lote: ${documents.length}`);

  const blockers: Blocker[] = [];

  // Guarda 6 (heredada): nada fuera del lote referencia a un documento del lote.
  const externalRefs = await prisma.fiscalDocument.findMany({
    where: {
      OR: [
        { affectedDocumentId: { in: docIds } },
        { replacesDocumentId: { in: docIds } },
        { supersedesDocumentId: { in: docIds } },
      ],
      id: { notIn: docIds },
    },
    select: { id: true, number: true },
  });
  for (const ref of externalRefs) {
    blockers.push({
      reason: `el documento ${ref.number ?? ref.id} referencia a uno del lote y no es él mismo del lote`,
    });
  }

  const orders = await prisma.salesOrder.findMany({
    where: { importBatchId: batchId },
    select: { id: true, seq: true, origin: true, customerId: true, status: true },
  });
  const orderIds = orders.map((o) => o.id);
  console.warn(`Pedidos del lote: ${orders.length}`);

  // Invariante: todo documento del lote apunta a un pedido del lote (D-141 es 1:1, y el CLI
  // estampa los dos con el mismo `import_batch_id` en el mismo paso). Que no coincida es una
  // corrupción de datos, no un caso a resolver en silencio.
  const orderIdSet = new Set(orderIds);
  for (const doc of documents) {
    if (doc.salesOrderId && !orderIdSet.has(doc.salesOrderId)) {
      blockers.push({
        reason: `el documento ${doc.number ?? doc.id} apunta a un pedido que no tiene el mismo import_batch_id`,
      });
    }
  }
  for (const order of orders) {
    if (order.origin !== SalesOrderOrigin.IMPORTED) {
      blockers.push({ reason: `el pedido ${order.seq} del lote no es origin = IMPORTED` });
    }
  }

  const dispatches = await prisma.dispatch.findMany({
    where: { salesOrderId: { in: orderIds } },
    select: { seq: true },
  });
  for (const dispatch of dispatches) {
    blockers.push({ reason: `el pedido tiene el despacho ${dispatch.seq}` });
  }

  const reservations = await prisma.reservation.findMany({
    where: { OR: [{ salesOrderId: { in: orderIds } }, { importBatchId: batchId }] },
    select: { id: true, salesOrderId: true, status: true },
  });
  const reservationIds = reservations.map((r) => r.id);
  console.warn(`Reservas del lote: ${reservations.length}`);

  // Guarda 8: unión de las OP en cola (cuelgan de una reserva del lote) y las OP a stock del
  // déficit consolidado (D-142; no cuelgan de ninguna reserva, solo llevan `import_batch_id`).
  const productionOrders = await prisma.productionOrder.findMany({
    where: { OR: [{ reservationId: { in: reservationIds } }, { importBatchId: batchId }] },
    select: { id: true, seq: true, status: true, reservationId: true },
  });
  const opIds = productionOrders.map((o) => o.id);
  console.warn(`Órdenes de producción del lote: ${productionOrders.length}`);

  const acceptedOpStatus: ProductionOrderStatus[] = [
    ProductionOrderStatus.DRAFT,
    ProductionOrderStatus.CANCELLED,
  ];
  for (const op of productionOrders) {
    if (!acceptedOpStatus.includes(op.status)) {
      blockers.push({ reason: `la OP ${op.seq} está ${op.status}, no DRAFT ni CANCELLED` });
    }
  }

  const consumptions = await prisma.productionOrderConsumption.findMany({
    where: { productionOrderId: { in: opIds } },
    select: { productionOrderId: true },
  });
  const opSeqById = new Map(productionOrders.map((o) => [o.id, o.seq]));
  const reports = await prisma.productionReport.findMany({
    where: { productionOrderId: { in: opIds } },
    select: { id: true, productionOrderId: true, status: true },
  });
  const touchedOpIds = new Set([
    ...consumptions.map((c) => c.productionOrderId),
    ...reports.map((r) => r.productionOrderId),
  ]);

  // D-142-ii: sin `--exclude-touched`, cualquier OP tocada aborta el lote entero, como
  // siempre. Con el flag, se excluye del borrado el pedido dueño de esa OP (vía su reserva)
  // en vez de abortar — salvo que la OP no cuelgue de ninguna reserva (la OP a stock del
  // déficit consolidado, D-140): ahí no hay pedido al que atribuirle la exclusión y se aborta
  // igual, con el flag o sin él.
  const excludedOrderIds = new Set<string>();
  if (touchedOpIds.size > 0 && !excludeTouched) {
    for (const opId of touchedOpIds) {
      const seq = opSeqById.get(opId) ?? opId;
      if (consumptions.some((c) => c.productionOrderId === opId)) {
        blockers.push({ reason: `la OP ${seq} tiene (o tuvo) una bobina montada` });
      }
      if (reports.some((r) => r.productionOrderId === opId)) {
        blockers.push({ reason: `la OP ${seq} tiene un reporte de piezas` });
      }
    }
  } else if (touchedOpIds.size > 0) {
    const touchedOps = productionOrders.filter((o) => touchedOpIds.has(o.id));
    const orphanTouched = touchedOps.filter((o) => o.reservationId === null);
    for (const op of orphanTouched) {
      blockers.push({
        reason:
          `la OP ${op.seq} tocó producción real pero no cuelga de ninguna reserva: ` +
          '--exclude-touched no tiene a qué pedido atribuirle la exclusión',
      });
    }
    const touchedReservationIds = touchedOps
      .map((o) => o.reservationId)
      .filter((id): id is string => id !== null);
    for (const reservation of reservations) {
      if (touchedReservationIds.includes(reservation.id)) {
        excludedOrderIds.add(reservation.salesOrderId);
      }
    }
  }

  // D-143: --include-reverted promueve al borrado los pedidos excluidos que la reversa de
  // dominio ya dejó inertes — ver el comentario de cabecera para las cinco condiciones.
  const notPromoted: { seq: number; reasons: string[] }[] = [];
  if (includeReverted && excludedOrderIds.size > 0) {
    const touchedOps = productionOrders.filter((o) => touchedOpIds.has(o.id));
    const touchedReports = reports.filter((r) => touchedOpIds.has(r.productionOrderId));
    const reportIds = touchedReports.map((r) => r.id);
    const kardexMovements = reportIds.length
      ? await prisma.inventoryMovement.findMany({
          where: {
            refType: { in: [InventoryRefType.PRODUCTION, InventoryRefType.SCRAP] },
            refId: { in: reportIds },
          },
          select: { id: true, refId: true, reversalOfId: true },
        })
      : [];
    const reversedOriginalIds = new Set(
      kardexMovements
        .filter((m): m is typeof m & { reversalOfId: bigint } => m.reversalOfId !== null)
        .map((m) => m.reversalOfId),
    );
    const unreversedReportIds = new Set(
      kardexMovements
        .filter(
          (m): m is typeof m & { refId: string } =>
            m.reversalOfId === null && m.refId !== null && !reversedOriginalIds.has(m.id),
        )
        .map((m) => m.refId),
    );
    const reservationOwnerById = new Map(reservations.map((r) => [r.id, r.salesOrderId]));

    for (const orderId of [...excludedOrderIds]) {
      const order = orders.find((o) => o.id === orderId);
      const reasons: string[] = [];
      if (order?.status !== SalesOrderStatus.CANCELLED) {
        reasons.push('el pedido no está CANCELLED');
      }
      const deadDocStatuses: FiscalDocumentStatus[] = [
        FiscalDocumentStatus.ANNULLED,
        FiscalDocumentStatus.VOIDED,
        FiscalDocumentStatus.REJECTED,
      ];
      for (const doc of documents.filter((d) => d.salesOrderId === orderId)) {
        if (!deadDocStatuses.includes(doc.status)) {
          reasons.push(`el comprobante ${doc.number ?? doc.id} sigue ${doc.status}`);
        }
      }
      for (const reservation of reservations.filter((r) => r.salesOrderId === orderId)) {
        if (reservation.status === ReservationStatus.ACTIVE) {
          reasons.push(`la reserva ${reservation.id} sigue ACTIVE`);
        }
      }
      const ownOps = touchedOps.filter(
        (o) => o.reservationId !== null && reservationOwnerById.get(o.reservationId) === orderId,
      );
      for (const op of ownOps) {
        if (op.status !== ProductionOrderStatus.CANCELLED) {
          reasons.push(`la OP ${op.seq} no está CANCELLED`);
        }
        const opReportIds = touchedReports
          .filter((r) => r.productionOrderId === op.id)
          .map((r) => r.id);
        if (opReportIds.some((id) => unreversedReportIds.has(id))) {
          reasons.push(`la OP ${op.seq} tiene un movimiento de kardex sin revertir`);
        }
      }

      if (reasons.length === 0) {
        excludedOrderIds.delete(orderId);
      } else {
        notPromoted.push({ seq: order?.seq ?? -1, reasons });
      }
    }
  }

  const movements =
    opIds.length === 0
      ? []
      : await prisma.inventoryMovement.findMany({
          where: {
            refType: {
              in: [InventoryRefType.SALE, InventoryRefType.PRODUCTION, InventoryRefType.SCRAP],
            },
            refId: { in: [...docIds, ...opIds] },
          },
          select: { id: true, refType: true, refId: true },
        });
  for (const m of movements) {
    blockers.push({
      reason: `hay un movimiento de kardex (${m.refType}, id ${m.id}) que referencia ${m.refId}`,
    });
  }

  if (blockers.length > 0) {
    console.error('');
    console.error(`BLOQUEADO — ${blockers.length} motivo(s), no se borró nada:`);
    for (const b of blockers) console.error(`  - ${b.reason}`);
    process.exitCode = 1;
    return;
  }

  // Un pedido excluido (D-142-ii) sigue "en el lote" para toda invariante de arriba — solo no
  // entra al DELETE. De acá para abajo, "borrable" filtra a los excluidos.
  const excludedOrders = orders.filter((o) => excludedOrderIds.has(o.id));
  const deletableOrders = orders.filter((o) => !excludedOrderIds.has(o.id));
  const deletableOrderIds = deletableOrders.map((o) => o.id);
  const deletableDocs = documents.filter(
    (d) => d.salesOrderId === null || !excludedOrderIds.has(d.salesOrderId),
  );
  const deletableDocIds = deletableDocs.map((d) => d.id);
  const deletableReservations = reservations.filter((r) => !excludedOrderIds.has(r.salesOrderId));
  const deletableReservationIds = deletableReservations.map((r) => r.id);
  const deletableReservationIdSet = new Set(deletableReservationIds);
  const deletableProductionOrders = productionOrders.filter(
    (o) => o.reservationId === null || deletableReservationIdSet.has(o.reservationId),
  );
  const deletableOpIds = deletableProductionOrders.map((o) => o.id);

  if (excludedOrders.length > 0) {
    console.warn('');
    console.warn(
      `Excluidos del borrado físico (--exclude-touched): ${excludedOrders.length} pedido(s) ` +
        'con producción real — quedan tal cual, sin tocar:',
    );
    for (const o of excludedOrders) console.warn(`    pedido ${o.seq}`);
  }
  if (includeReverted && notPromoted.length > 0) {
    console.warn('');
    console.warn(
      `--include-reverted no incluyó ${notPromoted.length} pedido(s) — sin forzar, quedan excluidos:`,
    );
    for (const p of notPromoted) {
      console.warn(`    pedido ${p.seq}:`);
      for (const reason of p.reasons) console.warn(`      - ${reason}`);
    }
  }

  // Guarda 9: clientes y SKUs que el lote creó, pero solo se borran si nada de **afuera del
  // borrado** los usa. Un pedido/comprobante excluido cuenta como "afuera" — sigue existiendo
  // y sigue apuntándolos.
  const customers = await prisma.customer.findMany({
    where: { importBatchId: batchId },
    select: { id: true, name: true, docNumber: true },
  });
  const keepCustomerIds = new Set<string>();
  for (const c of customers) {
    const [otherOrder, otherDoc] = await Promise.all([
      prisma.salesOrder.findFirst({
        where: { customerId: c.id, id: { notIn: deletableOrderIds } },
        select: { id: true },
      }),
      prisma.fiscalDocument.findFirst({
        where: { customerId: c.id, id: { notIn: deletableDocIds } },
        select: { id: true },
      }),
    ]);
    if (otherOrder || otherDoc) keepCustomerIds.add(c.id);
  }

  const products = await prisma.product.findMany({
    where: { importBatchId: batchId },
    select: { id: true, sku: true },
  });
  const keepProductIds = new Set<string>();
  for (const p of products) {
    const [otherItem, otherInvoiceItem, otherOp, balance] = await Promise.all([
      prisma.salesOrderItem.findFirst({
        where: { productId: p.id, salesOrderId: { notIn: deletableOrderIds } },
        select: { id: true },
      }),
      prisma.fiscalDocumentItem.findFirst({
        where: { productId: p.id, documentId: { notIn: deletableDocIds } },
        select: { id: true },
      }),
      prisma.productionOrder.findFirst({
        where: { productId: p.id, id: { notIn: deletableOpIds } },
        select: { id: true },
      }),
      prisma.inventoryBalance.findFirst({
        where: { itemType: 'PRODUCT', itemId: p.id },
        select: { id: true },
      }),
    ]);
    if (otherItem || otherInvoiceItem || otherOp || balance) keepProductIds.add(p.id);
  }

  const deletableCustomers = customers.filter((c) => !keepCustomerIds.has(c.id));
  const deletableProducts = products.filter((p) => !keepProductIds.has(p.id));

  console.warn('');
  console.warn('Sin bloqueos. Conjunto a borrar:');
  console.warn(`  comprobantes: ${deletableDocs.length}`);
  console.warn(`  pedidos: ${deletableOrders.length}`);
  console.warn(`  reservas: ${deletableReservations.length}`);
  console.warn(`  órdenes de producción: ${deletableProductionOrders.length}`);
  console.warn(
    `  clientes: ${deletableCustomers.length} de ${customers.length} ` +
      `(${keepCustomerIds.size} conservados por estar referenciados fuera del lote)`,
  );
  console.warn(
    `  SKUs: ${deletableProducts.length} de ${products.length} ` +
      `(${keepProductIds.size} conservados por estar referenciados fuera del lote)`,
  );
  for (const c of customers.filter((c) => keepCustomerIds.has(c.id))) {
    console.warn(`    conservado: cliente ${c.docNumber} — ${c.name}`);
  }
  for (const p of products.filter((p) => keepProductIds.has(p.id))) {
    console.warn(`    conservado: SKU ${p.sku}`);
  }

  if (!execute) {
    console.warn('');
    console.warn('Simulación: nada se borró. Repetí con --execute para borrar de verdad.');
    return;
  }

  const counts = await prisma.$transaction(async (tx) => {
    const reportsDeleted = await tx.productionReport.deleteMany({
      where: { productionOrderId: { in: deletableOpIds } },
    });
    const consumptionsDeleted = await tx.productionOrderConsumption.deleteMany({
      where: { productionOrderId: { in: deletableOpIds } },
    });
    const opItemsDeleted = await tx.productionOrderItem.deleteMany({
      where: { productionOrderId: { in: deletableOpIds } },
    });
    const opsDeleted = await tx.productionOrder.deleteMany({
      where: { id: { in: deletableOpIds } },
    });

    const docItemsDeleted = await tx.fiscalDocumentItem.deleteMany({
      where: { documentId: { in: deletableDocIds } },
    });
    const paymentsDeleted = await tx.customerPayment.deleteMany({
      where: { documentId: { in: deletableDocIds } },
    });
    const documentsDeleted = await tx.fiscalDocument.deleteMany({
      where: { id: { in: deletableDocIds } },
    });

    const reservationsDeleted = await tx.reservation.deleteMany({
      where: { id: { in: deletableReservationIds } },
    });

    const orderPiecesDeleted = await tx.salesOrderItemPiece.deleteMany({
      where: { salesOrderItem: { salesOrderId: { in: deletableOrderIds } } },
    });
    const orderItemsDeleted = await tx.salesOrderItem.deleteMany({
      where: { salesOrderId: { in: deletableOrderIds } },
    });
    const ordersDeleted = await tx.salesOrder.deleteMany({
      where: { id: { in: deletableOrderIds } },
    });

    // Clientes y SKUs, al final: para entonces ya no queda nada del propio lote que los
    // referencie, y lo que los referenciaba desde afuera ya se comprobó que no existe.
    const customersDeleted = await tx.customer.deleteMany({
      where: { id: { in: deletableCustomers.map((c) => c.id) } },
    });
    const productsDeleted = await tx.product.deleteMany({
      where: { id: { in: deletableProducts.map((p) => p.id) } },
    });

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
      customersDeleted: customersDeleted.count,
      productsDeleted: productsDeleted.count,
    };
  });

  console.warn('');
  console.warn('Borrado. Conteos por tabla:');
  for (const [table, count] of Object.entries(counts)) console.warn(`  ${table}: ${count}`);
}

(batchArg ? purgeBatch(batchArg) : main())
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
