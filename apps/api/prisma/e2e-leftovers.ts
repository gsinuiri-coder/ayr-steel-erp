/**
 * Inventario SOLO LECTURA de lo que los E2E de escritura dejan en la base (D-024).
 * Cuenta y lista las entidades con marcas de prueba para poder documentarlo tras cada
 * `pnpm e2e:prod` y revisarlo a simple vista. No borra nada ni imprime datos reales del
 * negocio. Se invoca desde `scripts/prod-e2e-leftovers.mjs`, que le pasa la conexión.
 */
import { PrismaClient } from '@prisma/client';
import { toDecimal } from '@ayr/shared';
import { E2E_EMAIL_PREFIX, E2E_EMAIL_SUFFIX } from './e2e-users';

const TEST_NAME = { contains: 'E2E', mode: 'insensitive' as const };

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const [
      suppliers,
      finishes,
      products,
      coils,
      purchases,
      movements,
      profiles,
      orders,
      colors,
      customers,
      quotations,
      salesOrders,
      reservations,
      dispatches,
      fiscalDocuments,
      livePayments,
      cashSessions,
    ] = await Promise.all([
      prisma.supplier.findMany({
        where: { name: TEST_NAME },
        select: { code: true, isActive: true },
      }),
      prisma.finish.findMany({ where: { name: TEST_NAME }, select: { isActive: true } }),
      prisma.product.findMany({
        where: { sku: { startsWith: 'BOB' } },
        select: { sku: true, isActive: true },
      }),
      prisma.coil.findMany({
        where: { supplier: { name: TEST_NAME } },
        select: { code: true, status: true },
      }),
      prisma.purchase.findMany({
        where: { supplier: { name: TEST_NAME } },
        select: { series: true, number: true, type: true, status: true, total: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.inventoryMovement.count(),
      // Fase 4: perfiles de prueba (`E2E…`) y sus órdenes de producción. Las piezas que
      // una OP cerrada dejó en stock se ven en `profileStock`: es lo que `prod:purge-e2e`
      // tiene que dejar en cero reabriendo la OP y revirtiendo sus reportes (D-060).
      prisma.product.findMany({
        where: { sku: { startsWith: 'E2E-' } },
        select: { id: true, sku: true, isActive: true },
      }),
      prisma.productionOrder.findMany({
        where: { product: { sku: { startsWith: 'E2E-' } } },
        // Desde Fase 6 el listado trae las dos clases de orden (D-087): el `kind` es lo que
        // dice si una que quedó viva retiene un fleje o una bobina entera.
        select: { seq: true, status: true, kind: true },
        orderBy: { seq: 'asc' },
      }),
      // Fase 6 (D-085): un color de prueba activo no bloquea nada, pero ensucia el selector
      // que planta usa para elegir el rollo, así que se cuenta como residuo.
      prisma.color.findMany({
        where: { code: { startsWith: 'E2E' } },
        select: { code: true, name: true, isActive: true },
        orderBy: { code: 'asc' },
      }),
      // Fase 5a: clientes, cotizaciones, pedidos y —lo que de verdad importa— reservas.
      // Una reserva ACTIVA sobreviviente bloquea merma, corte, cierre y anulación de la
      // bobina (D-066), así que es el residuo más caro que puede quedar en producción.
      prisma.customer.findMany({
        where: { name: TEST_NAME },
        select: { name: true, isActive: true },
      }),
      prisma.quotation.findMany({
        where: { customer: { name: TEST_NAME } },
        select: { seq: true, status: true },
        orderBy: { seq: 'asc' },
      }),
      prisma.salesOrder.findMany({
        where: { customer: { name: TEST_NAME } },
        select: { seq: true, status: true },
        orderBy: { seq: 'asc' },
      }),
      prisma.reservation.findMany({
        where: { status: 'ACTIVE' },
        select: {
          qty: true,
          unit: true,
          itemType: true,
          itemId: true,
          salesOrder: { select: { seq: true, customer: { select: { name: true } } } },
        },
      }),
      // Fase 5b: lo que el ciclo fiscal y logístico puede dejar en producción. El rastro
      // que importa no es el papel —un comprobante dado de baja **debe** seguir existiendo—
      // sino el **stock** que un despacho vivo mantiene fuera del almacén y el **saldo** de
      // una cuenta por cobrar inventada. Los dos tienen que quedar en cero.
      prisma.dispatch.findMany({
        where: { salesOrder: { customer: { name: TEST_NAME } } },
        select: { seq: true, status: true },
      }),
      // La boleta a "público en general" (D-077) no sale a nombre del cliente de prueba:
      // se reconoce por la marca en observaciones, que es lo que ponen los tests.
      prisma.fiscalDocument.findMany({
        where: {
          OR: [{ customer: { name: TEST_NAME } }, { notes: { startsWith: 'E2E ' } }],
        },
        select: { number: true, docType: true, status: true, totalPen: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.customerPayment.findMany({
        where: {
          reversedAt: null,
          document: {
            OR: [{ customer: { name: TEST_NAME } }, { notes: { startsWith: 'E2E ' } }],
          },
        },
        select: { amountPen: true, document: { select: { number: true } } },
      }),
      // Fase 7b (D-101): los turnos de caja del mostrador cuelgan del **usuario**, así que
      // se reconocen por el correo efímero de E2E y no por una marca en el texto. Un turno
      // `OPEN` que sobrevive a la corrida es el residuo que importa: bloquea el borrado del
      // usuario en `cleanup-e2e-users.ts` y deja una caja abierta en producción.
      prisma.cashSession.findMany({
        where: {
          user: { email: { startsWith: E2E_EMAIL_PREFIX, endsWith: E2E_EMAIL_SUFFIX } },
        },
        select: {
          seq: true,
          status: true,
          differencePen: true,
          user: { select: { email: true } },
          _count: { select: { sales: true } },
        },
        orderBy: { openedAt: 'asc' },
      }),
    ]);

    // `inventory_balances.item_id` es polimórfico (§3.2): no hay FK que unir, así que el
    // saldo de los perfiles de prueba se pide con los ids ya resueltos.
    const profileStock = profiles.length
      ? await prisma.inventoryBalance.findMany({
          where: { itemType: 'PRODUCT', itemId: { in: profiles.map((p) => p.id) } },
          select: { itemId: true, qty: true },
        })
      : [];

    const active = (rows: { isActive: boolean }[]) => rows.filter((r) => r.isActive).length;
    console.warn(`proveedores E2E: ${suppliers.length} (activos: ${active(suppliers)})`);
    console.warn(`acabados E2E: ${finishes.length} (activos: ${active(finishes)})`);
    console.warn(
      `productos BOB de trading (D-037): ${products.length} (activos: ${active(products)})`,
    );
    console.warn(
      `bobinas de proveedores E2E: ${coils.length} [${coils.map((c) => c.status).join(', ')}]`,
    );
    console.warn(`compras de proveedores E2E: ${purchases.length}`);
    for (const p of purchases) {
      console.warn(`  ${p.series}-${p.number}  ${p.type}  ${p.status}  ${p.total.toFixed(2)}`);
    }
    console.warn(
      `perfiles E2E de drywall (Fase 4): ${profiles.length} (activos: ${active(profiles)})`,
    );
    console.warn(
      `órdenes de producción E2E: ${orders.length} [${orders
        .map((o) => `${o.kind}:${o.status}`)
        .join(', ')}]`,
    );
    console.warn(`colores E2E: ${colors.length} (activos: ${active(colors)})`);
    for (const c of colors.filter((x) => x.isActive)) {
      console.warn(`  ${c.code} — ${c.name}`);
    }
    // Regla dura 1: una cantidad de kardex no se compara con `Number` ni siquiera acá.
    const piecesInStock = profileStock.filter((b) => toDecimal(b.qty.toString()).gt(0));
    console.warn(`perfiles E2E con piezas en stock: ${piecesInStock.length}`);
    for (const b of piecesInStock) {
      const sku = profiles.find((p) => p.id === b.itemId)?.sku ?? b.itemId;
      console.warn(`  ${sku} — ${b.qty.toFixed(3)} piezas`);
    }
    console.warn(`clientes E2E: ${customers.length} (activos: ${active(customers)})`);
    console.warn(
      `cotizaciones E2E: ${quotations.length} [${quotations.map((q) => q.status).join(', ')}]`,
    );
    console.warn(
      `pedidos E2E: ${salesOrders.length} [${salesOrders.map((o) => o.status).join(', ')}]`,
    );
    console.warn(`reservas ACTIVAS en toda la base: ${reservations.length}`);
    for (const r of reservations) {
      console.warn(
        `  ${r.itemType} ${r.itemId} — ${r.qty.toFixed(3)} ${r.unit} — PED-${String(
          r.salesOrder.seq,
        ).padStart(6, '0')} (${r.salesOrder.customer.name})`,
      );
    }
    // Fase 5b. Un despacho `ISSUED` es material de prueba **fuera del almacén**: es el
    // residuo que la purga tiene que dejar en cero revirtiéndolo.
    const liveDispatches = dispatches.filter((d) => d.status === 'ISSUED');
    console.warn(
      `despachos E2E: ${dispatches.length} (vivos: ${liveDispatches.length}) [${dispatches
        .map((d) => d.status)
        .join(', ')}]`,
    );
    console.warn(`documentos electrónicos E2E: ${fiscalDocuments.length}`);
    for (const d of fiscalDocuments) {
      console.warn(
        `  ${d.number ?? 'borrador'}  ${d.docType}  ${d.status}  ${d.totalPen.toFixed(2)}`,
      );
    }
    // Un cobro vigente sobre un comprobante de prueba es dinero inventado en la cuenta por
    // cobrar: tiene que quedar en cero.
    console.warn(`cobros vigentes sobre comprobantes E2E: ${livePayments.length}`);
    for (const payment of livePayments) {
      console.warn(`  ${payment.document.number ?? 'borrador'} — ${payment.amountPen.toFixed(2)}`);
    }
    // Fase 7b: caja del mostrador. Lo que no puede quedar es un turno abierto o una venta
    // de mostrador viva; un turno cerrado y sin ventas lo borra `cleanup-e2e-users.ts`.
    const openSessions = cashSessions.filter((c) => c.status === 'OPEN');
    const sessionsWithSales = cashSessions.filter((c) => c._count.sales > 0);
    console.warn(
      `turnos de caja E2E: ${cashSessions.length} (abiertos: ${openSessions.length}, con ventas: ${sessionsWithSales.length})`,
    );
    for (const c of cashSessions) {
      console.warn(
        `  CAJA-${String(c.seq).padStart(6, '0')}  ${c.status}  ventas: ${c._count.sales}  diferencia: ${c.differencePen?.toFixed(2) ?? '—'}`,
      );
    }
    console.warn(`movimientos de kardex en total: ${movements}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
