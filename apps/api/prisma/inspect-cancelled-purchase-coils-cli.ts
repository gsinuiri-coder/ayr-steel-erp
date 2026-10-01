/**
 * Inventario de bobinas de compra anuladas: lectura transaccional, sin modo execute.
 *
 * D-375: imprime el mismo plan que usa la restauración (`planCoilRestores`), así la foto y lo
 * que haría `restore:cancelled-coils` no pueden divergir.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_HISTORICAL_LOAD_START } from '@ayr/shared';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import { planCoilRestores } from '../src/coils/coil-restore';

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
  const floor = process.env.HISTORICAL_LOAD_START ?? DEFAULT_HISTORICAL_LOAD_START;
  const db = new PrismaClient();
  try {
    const plans = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return planCoilRestores(tx, floor);
      },
      { timeout: 120_000 },
    );
    console.warn(`Rama ${branch}; foto ${new Date().toISOString()}; transacción READ ONLY`);
    console.warn(
      'Bobina | Compra (estado) | Kg | Costo/kg PEN | Entrada original | Modo | Fecha | Motivo',
    );
    if (plans.length === 0) console.warn('(ninguna)');
    for (const p of plans) {
      console.warn(
        `${p.code} | ${p.purchaseDocument ?? '—'} (${p.purchaseStatus ?? '—'}) | ${p.qty ?? '—'} | ${p.unitCostPen ?? '—'} | ${p.originalDate ?? '—'} | ${p.mode} | ${p.date ?? '—'} | ${p.reasons.join('; ') || '—'}`,
      );
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
