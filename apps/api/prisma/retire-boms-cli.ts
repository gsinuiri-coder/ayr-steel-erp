/* eslint-disable no-console -- script operacional: reporta lo que encuentra y lo que hace. */
/**
 * CLI de la retirada de recetas de drywall (D-344).
 *
 * Drywall deja de usar receta y la base pasa a rechazar una receta activa (CHECK
 * `product_boms_none_active_ck`, migración `d344_drywall_sin_receta`). Antes de aplicar esa
 * migración en una rama que todavía tenga recetas activas hay que desactivarlas: esta CLI lo hace
 * por el servicio de dominio (`retireActiveBoms`), auditado, nunca por SQL.
 *
 * **Dry-run por defecto**: lista las recetas activas y no escribe nada. `--execute` las desactiva
 * (contra production exige además `--confirm-production`, y la aprobación del dueño).
 *
 * Uso (vía `pnpm retire:boms`, que compila con `tsc -p tsconfig.cli.json`):
 *   pnpm retire:boms [--branch local|local-e2e|dev|demo|production]
 *   pnpm retire:boms --branch demo --execute
 *   pnpm retire:boms --branch production --confirm-production      (dry-run: confirma 0 activas)
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../src/audit/audit.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { findActiveBoms, retireActiveBoms } from '../src/production/bom-retirement';
import { assertExecuteAllowed } from './cli-gate';

const execute = process.argv.includes('--execute');

async function main(): Promise<void> {
  assertExecuteAllowed(execute);
  console.error(`Destino: ${process.env.AYR_CLI_BRANCH ?? '(sin declarar)'}`);

  const prisma = new PrismaClient();
  try {
    const active = await findActiveBoms(prisma);
    console.log(`Recetas activas: ${String(active.length)}`);
    for (const b of active) {
      console.log(
        `  ${b.productSku.padEnd(20)} ${b.kind} · espesor ${b.inputThicknessMm} · ancho ${b.inputWidthMm ?? '—'}`,
      );
    }
    if (!execute) {
      console.log(
        active.length === 0
          ? '\nDry-run: no hay recetas activas; la migración d344 se puede aplicar.'
          : '\nDry-run: no se escribió nada. Repetir con --execute para desactivarlas (auditado).',
      );
      return;
    }
    const audit = new AuditService(prisma as unknown as PrismaService);
    const result = await prisma.$transaction((tx) => retireActiveBoms(tx, audit), {
      timeout: 60_000,
    });
    console.log(
      `\nDesactivadas: ${String(result.retired)}. Quedan: ${String((await findActiveBoms(prisma)).length)}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
