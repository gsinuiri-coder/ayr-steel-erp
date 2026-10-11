/**
 * cc46 (D-608, D-609) — diagnóstico de los partidos internos de bobina (RF-15) con kerf o borde.
 * **Solo lectura**: una transacción `READ ONLY`, sin modo execute y sin reparar nada. Imprime un
 * JSON en stdout (para guardarlo en `local-data/cc46/`, que no se sube al repo) y un resumen en
 * stderr.
 *
 * De cada partido vigente cuenta el `kerfLossKg` (kerf declarado más el recorte de borde) que salió
 * con la madre y lo valoriza al costo de la salida del partido: es el valor que antes de D-608 no
 * quedó en ninguna hija. Los partidos anteriores a D-608 no se reparan (D-609).
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
        const byStatus = await tx.coilSplit.groupBy({ by: ['status'], _count: { _all: true } });
        const active = await tx.coilSplit.findMany({
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            createdAt: true,
            splitWeightKg: true,
            kerfLossMm: true,
            kerfLossKg: true,
            parentCoil: { select: { code: true, widthMm: true, currency: true } },
          },
        });
        const outs = await tx.inventoryMovement.findMany({
          where: {
            refType: 'SPLIT',
            type: 'OUT',
            reversalOfId: null,
            reversals: { none: {} },
            refId: { in: active.map((s) => s.id) },
          },
          select: { refId: true, unitCost: true, totalCost: true },
        });
        const outBySplit = new Map(outs.map((m) => [m.refId, m]));
        let kerfKg = new Decimal(0);
        let kerfValuePen = new Decimal(0);
        const withKerf = [];
        for (const split of active) {
          const kg = toDecimal(split.kerfLossKg.toString());
          if (kg.lte(0)) continue;
          const out = outBySplit.get(split.id);
          const value = out ? kg.times(out.unitCost.toString()) : null;
          kerfKg = kerfKg.plus(kg);
          if (value) kerfValuePen = kerfValuePen.plus(value);
          withKerf.push({
            parentCoil: split.parentCoil.code,
            currency: split.parentCoil.currency,
            createdAt: split.createdAt.toISOString(),
            parentWidthMm: split.parentCoil.widthMm.toFixed(2),
            splitWeightKg: split.splitWeightKg.toFixed(3),
            kerfLossMm: split.kerfLossMm.toFixed(2),
            kerfLossKg: kg.toFixed(3),
            outUnitCostPen: out ? out.unitCost.toFixed(4) : null,
            kerfValuePen: value ? value.toFixed(2) : null,
          });
        }
        return {
          branch,
          takenAt: new Date().toISOString(),
          splitsByStatus: byStatus.map((g) => ({ status: g.status, count: g._count._all })),
          activeSplits: active.length,
          activeSplitsWithKerf: withKerf.length,
          activeSplitsWithoutOutMovement: active.filter((s) => !outBySplit.has(s.id)).length,
          kerfKg: kerfKg.toFixed(3),
          kerfValuePenAtOutCost: kerfValuePen.toFixed(2),
          splits: withKerf,
        };
      },
      { timeout: 120_000 },
    );
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    console.error(`Rama ${branch}; foto ${report.takenAt}; transacción READ ONLY`);
    console.error(
      `Partidos vigentes: ${report.activeSplits} (con kerf o borde: ${report.activeSplitsWithKerf})`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
