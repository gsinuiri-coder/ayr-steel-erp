/**
 * Adelanta el correlativo de las series fiscales de la base de PRUEBAS tras reset y seed.
 * El guard de `test-db-guard.ts` impide tocar una base con historia. La suite común conserva
 * D-202: `10 000 000 + (epoch en segundos mod 80 000 000)`.
 *
 * D-365: `pnpm e2e:pse` recibe una base por serie, 100 después del último correlativo usado.
 * El reloj saltaba cientos de miles entre ventanas y Nubefact admite solo los 200 siguientes
 * al último registrado, incluso después de limpiar la cuenta demo.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { assertTestDatabase } from './test-db-guard';

const FLOOR = 10_000_000;
const RANGE = 80_000_000;
/**
 * D-596 (cc43): la CI corre la suite en 2 shards, cada uno con su base, que pasan por acá con
 * segundos de diferencia y emiten contra la misma cuenta demo de Nubefact. Sin separarlos, los
 * dos tomarían los mismos números. `E2E_SHARD` (1, 2) corre la base del shard 2 a la mitad del
 * rango; sin la variable (local, `e2e:smoke`) la base es la de siempre.
 */
const SHARD_STRIDE = RANGE / 2;

function shardOffset(): number {
  const shard = Number(process.env.E2E_SHARD ?? '1');
  if (!Number.isInteger(shard) || shard < 1 || shard > 2) {
    throw new Error('E2E_SHARD tiene que ser 1 o 2');
  }
  return (shard - 1) * SHARD_STRIDE;
}

function runCorrelativeBase(nowMs: number): number {
  return FLOOR + ((Math.floor(nowMs / 1000) + shardOffset()) % RANGE);
}

async function main(): Promise<void> {
  const label = assertTestDatabase();
  const prisma = new PrismaClient();
  try {
    if (process.env.E2E_PSE === '1') {
      const bases = JSON.parse(process.env.E2E_PSE_BASES ?? 'null') as Record<
        string,
        unknown
      > | null;
      const rows = await prisma.fiscalSeries.findMany({ select: { series: true } });
      const enabled = rows.filter((row) => row.series !== 'BC01');
      if (
        !bases ||
        rows.length !== enabled.length + 1 ||
        enabled.length !== Object.keys(bases).length ||
        enabled.some(
          (row) => !Number.isSafeInteger(bases[row.series]) || Number(bases[row.series]) < 0,
        )
      ) {
        throw new Error('Faltan bases PSE válidas para las series fiscales de prueba');
      }
      // BC01 queda inactiva hasta conocer su último correlativo en Nubefact.
      const disabled = await prisma.fiscalSeries.updateMany({
        where: { series: 'BC01' },
        data: { isActive: false },
      });
      if (disabled.count !== 1) throw new Error('No se pudo desactivar BC01 en el gate PSE');
      for (const row of enabled) {
        const base = Number(bases[row.series]);
        const { count } = await prisma.fiscalSeries.updateMany({
          where: { series: row.series, correlative: { lt: base } },
          data: { correlative: base },
        });
        if (count !== 1) throw new Error(`No se pudo fijar la base PSE de ${row.series}`);
      }
      console.warn(
        `Correlativos de ${label}: ${String(enabled.length)} series usan bases PSE de +100; BC01 inactiva.`,
      );
    } else {
      const base = runCorrelativeBase(Date.now());
      const { count } = await prisma.fiscalSeries.updateMany({
        where: { correlative: { lt: base } },
        data: { correlative: base },
      });
      console.warn(
        `Correlativos de ${label}: ${String(count)} series parten de ${String(base)} en esta corrida.`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
