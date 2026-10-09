/**
 * cc38 (D-573, D-574) — diagnóstico previo de las órdenes abiertas. **Solo lectura**: una
 * transacción `READ ONLY`, sin modo execute y sin reparar nada. Imprime un JSON en stdout (para
 * guardarlo en `local-data/cc38-cierre/diagnostico/`, que no se sube al repo) y un resumen en
 * stderr.
 *
 * Para cada orden de coberturas o accesorios en curso compara los metros del plan (en un
 * accesorio, los metros que encargó la línea del pedido) contra:
 * 1. lo registrado por los reportes vigentes: si ya excede el plan, la orden no podría cerrarse
 *    nunca con D-573/D-574;
 * 2. lo registrado más las filas del borrador: si excede, esas filas se rechazarán al registrar.
 */
import 'dotenv/config';
import { type Prisma, PrismaClient } from '@prisma/client';
import { Decimal, isAccessory, piecesMeters, toDecimal } from '@ayr/shared';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import { sumReportedMeters } from '../src/production/reported-meters';

type Tx = Prisma.TransactionClient;

const ZERO = new Decimal(0);
const pieceLike = (p: { lengthMm: Prisma.Decimal; qty: number }) => ({
  lengthMm: p.lengthMm.toFixed(2),
  qty: p.qty,
});

async function openOrders(tx: Tx) {
  const orders = await tx.productionOrder.findMany({
    where: { kind: 'ROOFING', status: { in: ['DRAFT', 'IN_PROGRESS'] } },
    select: {
      id: true,
      seq: true,
      status: true,
      product: { select: { unit: true, roofingKind: true, lengthMm: true } },
      reservation: { select: { salesOrderItem: { select: { qty: true } } } },
      items: { select: { lengthMm: true, qty: true } },
      reports: {
        where: { status: 'ACTIVE' },
        select: { metersM: true, piecesDetail: { select: { lengthMm: true, qty: true } } },
      },
      reportDrafts: { select: { pieces: { select: { lengthMm: true, qty: true } } } },
    },
    orderBy: { seq: 'asc' },
  });

  const rows = orders.map((order) => {
    const accessory = isAccessory(order.product);
    const planMeters = accessory
      ? toDecimal(order.reservation?.salesOrderItem?.qty.toString() ?? '0')
      : piecesMeters(order.items.map(pieceLike));
    const hasPlan = accessory ? order.reservation !== null : order.items.length > 0;
    const reported = sumReportedMeters(order.reports) ?? ZERO;
    const drafted = piecesMeters(order.reportDrafts.flatMap((d) => d.pieces.map(pieceLike)));
    return {
      seq: order.seq,
      status: order.status,
      kind: accessory ? 'ACCESORIO' : order.product.lengthMm === null ? 'A_MEDIDA' : 'PLANCHA',
      hasPlan,
      planMeters: planMeters.toFixed(3),
      reportedMeters: reported.toFixed(3),
      draftMeters: drafted.toFixed(3),
      draftRows: order.reportDrafts.length,
      reportedExceedsPlan: hasPlan && reported.gt(planMeters),
      reportedPlusDraftExceedsPlan: hasPlan && reported.plus(drafted).gt(planMeters),
      missingMeters: Decimal.max(planMeters.minus(reported), ZERO).toFixed(3),
    };
  });

  return {
    open: rows.length,
    inProgress: rows.filter((r) => r.status === 'IN_PROGRESS').length,
    withoutPlan: rows.filter((r) => !r.hasPlan).length,
    reportedExceedsPlan: rows.filter((r) => r.reportedExceedsPlan).length,
    reportedPlusDraftExceedsPlan: rows.filter(
      (r) => !r.reportedExceedsPlan && r.reportedPlusDraftExceedsPlan,
    ).length,
    withReportsAndIncomplete: rows.filter(
      (r) => r.hasPlan && toDecimal(r.reportedMeters).gt(0) && toDecimal(r.missingMeters).gt(0),
    ).length,
    note: 'reportedPlusDraftExceedsPlan cuenta solo las órdenes cuyo registrado NO excede ya el plan (las que exceden por el borrador). Accesorio: el plan son los metros de la línea del pedido.',
    orders: rows,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 0) {
    throw new Error(`Este subcomando es solo lectura y no acepta argumentos: ${args[0] ?? ''}`);
  }
  assertExecuteAllowed(false);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  const branch = process.env.AYR_CLI_BRANCH;
  if (!branch) throw new Error('Ejecutá este subcomando mediante runApiCli');
  const db = new PrismaClient();
  try {
    const report = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return {
          branch,
          takenAt: new Date().toISOString(),
          roofingByStatus: (
            await tx.productionOrder.groupBy({
              by: ['status'],
              where: { kind: 'ROOFING' },
              _count: { _all: true },
            })
          ).map((g) => ({ status: g.status, count: g._count._all })),
          openOrders: await openOrders(tx),
        };
      },
      { timeout: 120_000 },
    );
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    console.error(`Rama ${branch}; foto ${report.takenAt}; transacción READ ONLY`);
    console.error(
      `Coberturas por estado: ${report.roofingByStatus.map((g) => `${g.status} ${g.count}`).join(', ')}`,
    );
    const s = report.openOrders;
    console.error(
      `Abiertas: ${s.open} (en curso ${s.inProgress}, sin plan ${s.withoutPlan}); ` +
        `(1) registrado > plan: ${s.reportedExceedsPlan}; ` +
        `(2) registrado + borrador > plan: ${s.reportedPlusDraftExceedsPlan}; ` +
        `con registro y plan incompleto: ${s.withReportsAndIncomplete}`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
