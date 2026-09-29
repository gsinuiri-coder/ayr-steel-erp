/** Inventario de bobinas de compra anuladas: lectura transaccional, sin modo execute. */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import {
  assertCancelledPurchaseCoilsInspectionArgs,
  inspectCancelledPurchaseCoils,
} from '../src/coils/cancelled-purchase-coils-inspection';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  assertCancelledPurchaseCoilsInspectionArgs(args);
  assertExecuteAllowed(false);
  assertExternalOutputsOff(process.env, (line) => console.error(line));
  const branch = process.env.AYR_CLI_BRANCH;
  if (!branch) throw new Error('Ejecutá este subcomando mediante runApiCli');
  const db = new PrismaClient();
  try {
    const inspection = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return inspectCancelledPurchaseCoils(tx, branch);
    });
    console.warn(
      `Rama ${inspection.branch}; foto ${inspection.snapshotUtc}; transacción READ ONLY`,
    );
    console.warn(
      'SKU | Compra origen | Fecha compra | Kg | Entrada | Costo/kg | Veredicto | Movimientos posteriores',
    );
    if (inspection.coils.length === 0) console.warn('(ninguna)');
    for (const coil of inspection.coils) {
      const later = coil.laterMovements
        .map((m) => `${m.type}/${m.refType} #${m.id} ${m.operationDate}`)
        .join(', ');
      console.warn(
        `${coil.sku} | ${coil.purchaseDocument} (${coil.purchaseId}) | ${coil.purchaseDate} | ${coil.kg} | ${coil.entryDate ?? '—'} | ${coil.entryCostPerKg ?? '—'} | ${coil.verdict}${coil.reasons.length ? `: ${coil.reasons.join('; ')}` : ''} | ${later || '—'}`,
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
