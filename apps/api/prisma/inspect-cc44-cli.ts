/**
 * cc44 (D-597) — diagnóstico de las recepciones de corte tercerizado. **Solo lectura**: una
 * transacción `READ ONLY`, sin modo execute y sin reparar nada. Imprime un JSON en stdout (para
 * guardarlo en `local-data/cc44/`, que no se sube al repo) y un resumen en stderr.
 *
 * Cuenta las recepciones vigentes y, de cada una, el kerf y el borde que salieron con la madre
 * (`receivedKerfLossKg`) valorizados al costo de la salida: es el valor que antes de D-597 no
 * quedó en ningún fleje. Las recepciones anteriores a D-597 no se reparan (decisión del dueño).
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Decimal, toDecimal } from '@ayr/shared';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';

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
        const byStatus = await tx.cuttingOrderCoil.groupBy({
          by: ['status'],
          _count: { _all: true },
        });
        const received = await tx.cuttingOrderCoil.findMany({
          where: { status: 'RECEIVED' },
          select: { id: true, coilId: true, receivedKerfLossKg: true },
        });
        const outs = await tx.inventoryMovement.findMany({
          where: {
            refType: 'CUTTING',
            type: 'OUT',
            reversalOfId: null,
            reversals: { none: {} },
            refId: { in: received.map((r) => r.id) },
          },
          select: { refId: true, itemId: true, unitCost: true },
        });
        const outByRow = new Map(outs.map((m) => [`${m.refId}|${m.itemId}`, m]));
        let kerfKg = new Decimal(0);
        let kerfValuePen = new Decimal(0);
        let withKerf = 0;
        for (const row of received) {
          const kg = toDecimal(row.receivedKerfLossKg?.toString() ?? '0');
          if (kg.gt(0)) withKerf += 1;
          kerfKg = kerfKg.plus(kg);
          const out = outByRow.get(`${row.id}|${row.coilId}`);
          if (out) kerfValuePen = kerfValuePen.plus(kg.times(out.unitCost.toString()));
        }
        const strips = await tx.coil.count({
          where: { kind: 'STRIP', cuttingOrderCoilId: { not: null }, status: { not: 'CANCELLED' } },
        });
        return {
          branch,
          takenAt: new Date().toISOString(),
          cuttingOrderCoilsByStatus: byStatus.map((g) => ({
            status: g.status,
            count: g._count._all,
          })),
          receivedReceptions: received.length,
          receptionsWithKerf: withKerf,
          receptionsWithoutOutMovement: received.filter((r) => !outByRow.has(`${r.id}|${r.coilId}`))
            .length,
          liveStripsFromCutting: strips,
          kerfKg: kerfKg.toFixed(3),
          kerfValuePenAtOutCost: kerfValuePen.toFixed(2),
          note: 'kerfValuePenAtOutCost suma TODAS las recepciones vigentes: antes de D-597 ese valor salió con la madre; desde D-597 ya está repartido en los flejes. Para medir lo perdido, correrlo antes del deploy de cc44.',
        };
      },
      { timeout: 120_000 },
    );
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    console.error(`Rama ${branch}; foto ${report.takenAt}; transacción READ ONLY`);
    console.error(
      `Recepciones de corte vigentes: ${report.receivedReceptions} (con kerf o borde: ${report.receptionsWithKerf}); flejes vivos: ${report.liveStripsFromCutting}`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
