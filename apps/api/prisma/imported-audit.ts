/**
 * Auditoría de solo lectura de los comprobantes **importados** (RF-71, `origin = IMPORTED`)
 * de una rama de Neon. Existe porque un importado no tiene camino de baja hasta la Sesión
 * M-4: antes de darle uno hay que saber cuántos hay, cuáles son de prueba y qué saldo
 * sostienen, sin tocar nada.
 *
 * No imprime datos del negocio más allá de lo necesario para decidir: número, cliente,
 * total y saldo. Uso: `node scripts/prod-imported-audit.mjs`.
 */
import { PrismaClient } from '@prisma/client';
import { documentBalance, toDecimal, Decimal } from '@ayr/shared';

const prisma = new PrismaClient();

const LIVE = ['ISSUED', 'SEND_ERROR', 'ACCEPTED', 'VOID_PENDING'] as const;

/** Misma marca que usa `prod-e2e-purge.mjs` para decidir qué es de prueba. */
function isE2e(customerName: string, notes: string | null): boolean {
  return customerName.startsWith('E2E ') || (notes ?? '').startsWith('E2E ');
}

async function main(): Promise<void> {
  const documents = await prisma.fiscalDocument.findMany({
    where: { origin: 'IMPORTED' },
    orderBy: { createdAt: 'asc' },
    include: {
      customer: { select: { name: true, docNumber: true } },
      payments: { select: { amountPen: true, reversedAt: true } },
      creditNotes: {
        where: { status: { in: [...LIVE] }, archivedAt: null },
        select: { totalPen: true },
      },
    },
  });

  console.warn(`comprobantes importados: ${documents.length}`);
  let e2eCount = 0;
  let e2eBalance = new Decimal(0);
  let realCount = 0;

  for (const d of documents) {
    const paid = d.payments
      .filter((p) => p.reversedAt === null)
      .reduce((acc, p) => acc.plus(toDecimal(p.amountPen.toString())), new Decimal(0));
    const credited = d.creditNotes.reduce(
      (acc, n) => acc.plus(toDecimal(n.totalPen.toString())),
      new Decimal(0),
    );
    const balance = documentBalance({
      status: d.status,
      totalPen: d.totalPen.toString(),
      paidPen: paid,
      creditedPen: credited,
    });
    const mark = isE2e(d.customer.name, d.notes) ? 'E2E' : 'REAL';
    if (mark === 'E2E') {
      e2eCount += 1;
      if (d.archivedAt === null) e2eBalance = e2eBalance.plus(toDecimal(balance));
    } else {
      realCount += 1;
    }
    const archived = d.archivedAt === null ? '' : ' [archivado]';
    console.warn(
      `  ${mark} ${d.number ?? 'sin número'} ${d.docType} ${d.status}${archived} ` +
        `total ${d.totalPen.toFixed(2)} saldo ${toDecimal(balance).toFixed(2)} — ${d.customer.name}`,
    );
  }

  console.warn('');
  console.warn(`  de prueba (E2E): ${e2eCount}`);
  console.warn(`  del negocio (REAL): ${realCount}`);
  console.warn(`  saldo vivo inventado por los de prueba: ${e2eBalance.toFixed(2)}`);

  // Las series que la importación creó: nacen inactivas (D-106), pero un histórico de
  // prueba deja series `Z…` que tampoco tienen forma de borrarse.
  const series = await prisma.fiscalSeries.findMany({
    where: { isActive: false },
    orderBy: { createdAt: 'asc' },
    select: { series: true, docType: true, correlative: true, createdAt: true },
  });
  console.warn('');
  console.warn(`series inactivas: ${series.length}`);
  for (const s of series) {
    console.warn(`  ${s.series} ${s.docType} correlativo ${s.correlative}`);
  }

  const batches = await prisma.importBatch.count({ where: { entity: 'FISCAL_DOCUMENTS' } });
  console.warn('');
  console.warn(`lotes de importación de comprobantes: ${batches}`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
