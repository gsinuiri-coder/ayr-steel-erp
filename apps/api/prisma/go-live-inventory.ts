/* eslint-disable no-console -- guion de diagnostico: su salida ES la consola. */
/**
 * Inventario de **todo** lo operativo de una rama, para el go-live (D-129).
 *
 * `prod-e2e-leftovers.ts` responde "qué dejó la suite E2E", filtrando por el prefijo `E2E`.
 * Esto responde la pregunta del go-live, que es más ancha y más incómoda: **qué hay acá que no
 * debería existir el día que el cliente empiece a trabajar**. Incluye los ensayos hechos a mano
 * por el dueño, que no llevan ningún prefijo y que ninguna purga automática reconoce.
 *
 * No escribe nada. Clasifica cada fila en:
 *   - `E2E`     — lleva el prefijo de la suite (o cuelga de algo que lo lleva).
 *   - `ENSAYO`  — sin prefijo, pero con pinta de prueba (documentos TEST*, códigos de un solo
 *                 uso, entidades sin actividad real). Se lista entera para que la mire un humano.
 *   - `MAESTRO` — colores, acabados, líneas: se quedan, son configuración real.
 *
 * Uso: `node scripts/go-live-inventory.mjs --branch production`
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const isE2E = (s: string | null | undefined): boolean => /(^|\s)E2E/i.test(s ?? '');

async function main(): Promise<void> {
  const label = process.env.AYR_BRANCH_LABEL ?? 'la rama configurada';
  console.log(`\n=== Inventario de go-live — ${label} ===\n`);

  // --- Terceros ---
  const [customers, suppliers] = await Promise.all([
    prisma.customer.findMany({ select: { name: true, docNumber: true, isActive: true } }),
    prisma.supplier.findMany({ select: { code: true, name: true, isActive: true } }),
  ]);
  const realCustomers = customers.filter((c) => !isE2E(c.name));
  const realSuppliers = suppliers.filter((s) => !isE2E(s.name) && !isE2E(s.code));
  console.log(`Clientes: ${customers.length} (E2E: ${customers.length - realCustomers.length})`);
  for (const c of realCustomers) {
    console.log(`  NO-E2E  ${c.docNumber}  ${c.name}${c.isActive ? '' : '  (desactivado)'}`);
  }
  console.log(`Proveedores: ${suppliers.length} (E2E: ${suppliers.length - realSuppliers.length})`);
  for (const s of realSuppliers) {
    console.log(`  NO-E2E  ${s.code}  ${s.name}${s.isActive ? '' : '  (desactivado)'}`);
  }

  // --- Operaciones vivas: lo que de verdad importa que quede en cero ---
  const [coils, purchases, quotations, orders, dispatches, documents, productionOrders] =
    await Promise.all([
      prisma.coil.findMany({
        where: { status: { not: 'CANCELLED' } },
        select: { code: true, status: true, supplier: { select: { name: true } } },
        orderBy: { code: 'asc' },
      }),
      prisma.purchase.findMany({
        where: { status: { not: 'CANCELLED' } },
        select: {
          series: true,
          number: true,
          status: true,
          type: true,
          supplier: { select: { name: true } },
        },
      }),
      prisma.quotation.findMany({
        where: { status: { notIn: ['CANCELLED', 'EXPIRED'] } },
        select: { seq: true, status: true, customer: { select: { name: true } } },
      }),
      prisma.salesOrder.findMany({
        where: { status: { not: 'CANCELLED' } },
        select: { seq: true, status: true, customer: { select: { name: true } } },
      }),
      prisma.dispatch.findMany({
        where: { status: { not: 'REVERSED' } },
        select: { seq: true, status: true, salesOrder: { select: { seq: true } } },
      }),
      prisma.fiscalDocument.findMany({
        where: { archivedAt: null },
        select: { number: true, docType: true, status: true, customer: { select: { name: true } } },
      }),
      prisma.productionOrder.findMany({
        where: { status: { in: ['DRAFT', 'IN_PROGRESS', 'CLOSED'] } },
        select: { seq: true, status: true, kind: true, product: { select: { sku: true } } },
      }),
    ]);

  const section = <T>(title: string, rows: T[], line: (row: T) => string) => {
    console.log(`\n${title}: ${rows.length}`);
    for (const row of rows) console.log(`  ${line(row)}`);
  };

  section(
    'BOBINAS no anuladas',
    coils,
    (c) =>
      `${isE2E(c.code) || isE2E(c.supplier.name) ? 'E2E   ' : 'REVISAR'} ${c.code}  ${c.status}  ${c.supplier.name}`,
  );
  section(
    'COMPRAS no anuladas',
    purchases,
    (p) =>
      `${isE2E(p.supplier.name) ? 'E2E   ' : 'REVISAR'} ${p.series}-${p.number}  ${p.type}  ${p.status}  ${p.supplier.name}`,
  );
  section(
    'COTIZACIONES vivas',
    quotations,
    (q) =>
      `${isE2E(q.customer.name) ? 'E2E   ' : 'REVISAR'} COT-${String(q.seq).padStart(6, '0')}  ${q.status}  ${q.customer.name}`,
  );
  section(
    'PEDIDOS vivos',
    orders,
    (o) =>
      `${isE2E(o.customer.name) ? 'E2E   ' : 'REVISAR'} PED-${String(o.seq).padStart(6, '0')}  ${o.status}  ${o.customer.name}`,
  );
  section(
    'DESPACHOS vivos',
    dispatches,
    (d) =>
      `GRE-${String(d.seq).padStart(6, '0')}  ${d.status}  de PED-${String(d.salesOrder.seq).padStart(6, '0')}`,
  );
  section(
    'COMPROBANTES vigentes',
    documents,
    (f) =>
      `${isE2E(f.customer.name) ? 'E2E   ' : 'REVISAR'} ${f.number ?? '(borrador)'}  ${f.docType}  ${f.status}  ${f.customer.name}`,
  );
  section(
    'ÓRDENES DE PRODUCCIÓN no anuladas',
    productionOrders,
    (o) =>
      `${isE2E(o.product.sku) ? 'E2E   ' : 'REVISAR'} OP-${String(o.seq).padStart(6, '0')}  ${o.kind}  ${o.status}  ${o.product.sku}`,
  );

  // --- Saldos: el corazón del go-live. Cero stock de prueba. ---
  const balances = await prisma.inventoryBalance.findMany({
    where: { qty: { gt: 0 } },
    select: { itemType: true, itemId: true, qty: true, unit: true },
  });
  const productIds = balances.filter((b) => b.itemType === 'PRODUCT').map((b) => b.itemId);
  const coilIds = balances.filter((b) => b.itemType === 'COIL').map((b) => b.itemId);
  const [balProducts, balCoils] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } }),
    prisma.coil.findMany({ where: { id: { in: coilIds } }, select: { id: true, code: true } }),
  ]);
  const nameById = new Map<string, string>([
    ...balProducts.map((p) => [p.id, p.sku] as const),
    ...balCoils.map((c) => [c.id, c.code] as const),
  ]);
  console.log(`\nSALDOS CON STOCK (> 0): ${balances.length}`);
  for (const b of balances) {
    const name = nameById.get(b.itemId) ?? b.itemId;
    console.log(
      `  ${isE2E(name) ? 'E2E   ' : 'REVISAR'} ${b.itemType}  ${name}  ${b.qty.toFixed(3)} ${b.unit}`,
    );
  }

  // --- Maestros: se quedan, pero conviene ver cuántos son de prueba ---
  const [colors, finishes, products] = await Promise.all([
    prisma.color.findMany({ select: { code: true, name: true, isActive: true } }),
    prisma.finish.findMany({ select: { code: true, name: true, isActive: true } }),
    prisma.product.findMany({ select: { sku: true, isActive: true } }),
  ]);
  const e2eColors = colors.filter((c) => isE2E(c.code) || isE2E(c.name));
  const e2eFinishes = finishes.filter((f) => isE2E(f.code) || isE2E(f.name));
  const e2eProducts = products.filter((p) => isE2E(p.sku));
  console.log(
    `\nMAESTROS  colores ${colors.length} (E2E ${e2eColors.length}, activos E2E ${e2eColors.filter((c) => c.isActive).length})`,
  );
  console.log(
    `          acabados ${finishes.length} (E2E ${e2eFinishes.length}, activos E2E ${e2eFinishes.filter((f) => f.isActive).length})`,
  );
  console.log(
    `          productos ${products.length} (E2E ${e2eProducts.length}, activos E2E ${e2eProducts.filter((p) => p.isActive).length})`,
  );
  console.log('\nCriterio: todo lo marcado REVISAR necesita decisión humana.\n');
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
