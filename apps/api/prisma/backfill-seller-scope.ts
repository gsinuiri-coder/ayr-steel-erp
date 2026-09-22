/* eslint-disable no-console -- script operacional: reporta sus conteos. */
// RF-S3c: backfill del dueño comercial (`seller_id`) sobre las filas anteriores a D-239.
//
// La regla es **la misma que aplica el código en caliente**, no una aproximación:
//   - `quotations.seller_id`  = `created_by_id` (quien cotizó es el dueño comercial).
//   - `sales_orders.seller_id` = el `seller_id` de su cotización de origen
//     (`SalesOrdersService.confirmQuotation` hace `quotation.sellerId ?? quotation.createdById`).
//   - `sales_orders.seller_id` = `created_by_id` **solo** para los pedidos sin cotización
//     (directos), que es lo que hace `SalesOrdersService.create` con `sellerId: actor.id`.
//
// Derivar el pedido de su `created_by_id` sería el bug que se corrigió antes de la ventana:
// cuando un ADMINISTRADOR confirma la cotización de un vendedor, el creador del pedido es el
// admin, y el pedido terminaba fuera del alcance de quien lo vendió.
//
// Idempotente: todas las escrituras filtran por `seller_id IS NULL`, así que repetir la corrida
// no reasigna nada que ya tenga dueño — ni siquiera lo que M4 movió a mano después.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { resolveOrderSeller } from '../src/auth/seller-scope';

const prisma = new PrismaClient();
const execute = process.argv.includes('--execute');
const branchLabel = process.env.AYR_BRANCH_LABEL ?? '(sin etiqueta)';

interface Actor {
  id: string;
  name: string;
  email: string;
  role: string;
}

async function actorsById(ids: string[]): Promise<Map<string, Actor>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, email: true, role: true },
  });
  return new Map(rows.map((r) => [r.id, r as Actor]));
}

function label(actors: Map<string, Actor>, id: string | null): string {
  if (!id) return 'NULL';
  const a = actors.get(id);
  return a ? `${a.name} <${a.email}> [${a.role}]` : `${id} (usuario no encontrado)`;
}

/** Un pedido con el contexto de su cotización, aplanado para poder razonar sin escribir nada. */
interface PlannedOrder {
  id: string;
  seq: number;
  sellerId: string | null;
  createdById: string;
  quotationId: string | null;
  quotationSeq: number | null;
  quotationCreatedById: string | null;
  quotationSellerId: string | null;
}

async function planOrders(): Promise<PlannedOrder[]> {
  const rows = await prisma.salesOrder.findMany({
    select: {
      id: true,
      seq: true,
      sellerId: true,
      createdById: true,
      quotationId: true,
      quotation: { select: { seq: true, createdById: true, sellerId: true } },
    },
    orderBy: { seq: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    sellerId: r.sellerId,
    createdById: r.createdById,
    quotationId: r.quotationId,
    quotationSeq: r.quotation?.seq ?? null,
    quotationCreatedById: r.quotation?.createdById ?? null,
    quotationSellerId: r.quotation?.sellerId ?? null,
  }));
}

/**
 * Destino que la regla asigna. Delega en `resolveOrderSeller`, la misma función que usa
 * `SalesOrdersService.confirmQuotation`: si la regla cambia, cambia en los dos a la vez.
 */
function targetSeller(order: PlannedOrder): string | null {
  if (order.sellerId) return order.sellerId; // ya tiene dueño: no se toca
  return resolveOrderSeller({
    quotation:
      order.quotationId && order.quotationCreatedById
        ? { sellerId: order.quotationSellerId, createdById: order.quotationCreatedById }
        : null,
    createdById: order.createdById,
  });
}

async function report(phase: string): Promise<void> {
  console.log(`\n${'='.repeat(78)}\n${phase} — rama ${branchLabel}\n${'='.repeat(78)}`);

  const quotations = await prisma.quotation.findMany({
    select: { id: true, seq: true, createdById: true, sellerId: true },
    orderBy: { seq: 'asc' },
  });
  const orders = await planOrders();

  const actors = await actorsById([
    ...quotations.flatMap((q) => [q.createdById, q.sellerId ?? '']),
    ...orders.flatMap((o) => [
      o.createdById,
      o.sellerId ?? '',
      o.quotationCreatedById ?? '',
      o.quotationSellerId ?? '',
    ]),
  ]);

  // --- 1. Totales -----------------------------------------------------------
  const qNull = quotations.filter((q) => !q.sellerId).length;
  const oNull = orders.filter((o) => !o.sellerId).length;
  const oNullConCot = orders.filter((o) => !o.sellerId && o.quotationId).length;
  const oNullSinCot = orders.filter((o) => !o.sellerId && !o.quotationId).length;
  console.log('\n-- Totales --');
  console.log(`cotizaciones: ${quotations.length} (seller_id NULL: ${qNull})`);
  console.log(
    `pedidos:      ${orders.length} (seller_id NULL: ${oNull} — ` +
      `${oNullConCot} con cotización, ${oNullSinCot} directos)`,
  );

  // --- 2. Conteos por vendedor (destino que la regla asigna) -----------------
  const byQuotationSeller = new Map<string, number>();
  for (const q of quotations) {
    const target = q.sellerId ?? q.createdById;
    byQuotationSeller.set(target, (byQuotationSeller.get(target) ?? 0) + 1);
  }
  const byOrderSeller = new Map<string, number>();
  for (const o of orders) {
    const target = targetSeller(o) ?? 'NULL';
    byOrderSeller.set(target, (byOrderSeller.get(target) ?? 0) + 1);
  }
  for (const [title, map] of [
    ['-- Cotizaciones por vendedor --', byQuotationSeller],
    ['-- Pedidos por vendedor --', byOrderSeller],
  ] as const) {
    console.log(`\n${title}`);
    const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
    for (const [id, count] of sorted) {
      console.log(`  ${String(count).padStart(5)}  ${label(actors, id === 'NULL' ? null : id)}`);
    }
  }

  // --- 3. Pedidos cuyo creador difiere del creador de su cotización ----------
  const divergentes = orders.filter(
    (o) => o.quotationId && o.quotationCreatedById && o.createdById !== o.quotationCreatedById,
  );
  console.log(`\n-- Pedidos con creador distinto al de su cotización (${divergentes.length}) --`);
  if (divergentes.length === 0) {
    console.log('  ninguno.');
  } else {
    console.log('  Estos son los que el backfill anterior habría asignado mal.');
    for (const o of divergentes) {
      console.log(
        `  pedido #${o.seq} (cot. #${o.quotationSeq})\n` +
          `      creador del pedido: ${label(actors, o.createdById)}\n` +
          `      creador de la cot.: ${label(actors, o.quotationCreatedById)}\n` +
          `      queda asignado a:   ${label(actors, targetSeller(o))}`,
      );
    }
  }

  // --- 4. Cotizaciones creadas por un ADMINISTRADOR --------------------------
  const porAdmin = quotations.filter(
    (q) => actors.get(q.sellerId ?? q.createdById)?.role === 'ADMINISTRADOR',
  );
  console.log(`\n-- Cotizaciones que quedan a nombre de un ADMINISTRADOR (${porAdmin.length}) --`);
  if (porAdmin.length === 0) {
    console.log('  ninguna.');
  } else {
    console.log('  Es lo esperado: el admin es su propio dueño comercial. Si alguna debía ser');
    console.log('  de un vendedor, se mueve con M4 (PATCH /sales/quotations/:id/seller), que');
    console.log('  arrastra el pedido y deja rastro en audit_log. El backfill no la volverá a');
    console.log('  tocar porque ya no estará en NULL.');
    const agrupado = new Map<string, number[]>();
    for (const q of porAdmin) {
      const key = q.sellerId ?? q.createdById;
      agrupado.set(key, [...(agrupado.get(key) ?? []), q.seq]);
    }
    for (const [id, seqs] of agrupado) {
      console.log(`  ${label(actors, id)}: ${seqs.length} — #${seqs.join(', #')}`);
    }
  }

  // --- 5. NULL que quedarían después de aplicar la regla ---------------------
  const quedanNull = orders.filter((o) => targetSeller(o) === null);
  console.log(`\n-- Filas que quedarían en NULL tras el backfill (${quedanNull.length}) --`);
  if (quedanNull.length === 0) {
    console.log('  ninguna. `created_by_id` es NOT NULL en ambas tablas, así que toda');
    console.log('  cotización recibe dueño y todo pedido lo hereda de ella o de su creador.');
  } else {
    console.log('  ATENCIÓN: la regla no alcanza a estas filas. Revisar antes de --execute.');
    for (const o of quedanNull) {
      console.log(`  pedido #${o.seq} (cotización ${o.quotationSeq ?? 'sin cotización'})`);
    }
  }
}

async function main(): Promise<void> {
  await report(execute ? 'ANTES DEL BACKFILL' : 'DRY-RUN (no se escribe nada)');

  if (!execute) {
    console.log('\nDry-run: no se escribió nada. Repetir con --execute para aplicar el backfill.');
    return;
  }

  // Prisma no sabe expresar «seller_id = created_by_id» ni un UPDATE ... FROM en `updateMany`;
  // se usa SQL parametrizado dentro de una transacción. El orden importa: las cotizaciones
  // reciben dueño primero para que los pedidos puedan heredarlo en el mismo paso.
  const [cotizaciones, pedidosDeCotizacion, pedidosDirectos] = await prisma.$transaction(
    async (tx) => {
      const q = await tx.$executeRaw`
        UPDATE "quotations" SET "seller_id" = "created_by_id" WHERE "seller_id" IS NULL`;
      const oCot = await tx.$executeRaw`
        UPDATE "sales_orders" AS o SET "seller_id" = q."seller_id"
        FROM "quotations" AS q
        WHERE o."quotation_id" = q."id"
          AND o."seller_id" IS NULL
          AND q."seller_id" IS NOT NULL`;
      const oDir = await tx.$executeRaw`
        UPDATE "sales_orders" SET "seller_id" = "created_by_id"
        WHERE "seller_id" IS NULL AND "quotation_id" IS NULL`;
      return [q, oCot, oDir] as const;
    },
  );

  console.log('\n-- Filas escritas --');
  console.log(`  cotizaciones:            ${cotizaciones}`);
  console.log(`  pedidos desde cotización: ${pedidosDeCotizacion}`);
  console.log(`  pedidos directos:        ${pedidosDirectos}`);

  await report('DESPUÉS DEL BACKFILL');

  const pendientes = await prisma.salesOrder.count({ where: { sellerId: null } });
  const pendientesCot = await prisma.quotation.count({ where: { sellerId: null } });
  if (pendientes > 0 || pendientesCot > 0) {
    throw new Error(
      `Quedaron filas sin dueño comercial: ${pendientesCot} cotizaciones y ${pendientes} pedidos.`,
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
