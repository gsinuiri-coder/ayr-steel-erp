/* eslint-disable no-console -- script operacional: reporta sus conteos. */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const execute = process.argv.includes('--execute');

async function report(): Promise<void> {
  const [quotations, orders] = await Promise.all([
    prisma.quotation.groupBy({ by: ['createdById', 'sellerId'], _count: true }),
    prisma.salesOrder.groupBy({ by: ['createdById', 'sellerId'], _count: true }),
  ]);
  for (const [label, rows] of [['cotizaciones', quotations], ['pedidos', orders]] as const) {
    console.log(label);
    for (const row of rows) console.log(`  creador=${row.createdById} vendedor=${row.sellerId ?? 'NULL'} filas=${row._count}`);
  }
}

async function main(): Promise<void> {
  await report();
  if (!execute) {
    console.log('Dry-run: no se escribió nada. Repetir con --execute para aplicar el backfill.');
    return;
  }
  // Prisma no permite expresar «seller_id = created_by_id» en updateMany; se usa SQL
  // parametrizado dentro de una transacción. El wrapper prohíbe production.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE "quotations" SET "seller_id" = "created_by_id" WHERE "seller_id" IS NULL`;
    await tx.$executeRaw`UPDATE "sales_orders" SET "seller_id" = "created_by_id" WHERE "seller_id" IS NULL`;
  });
  console.log('Backfill aplicado; conteos finales:');
  await report();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
