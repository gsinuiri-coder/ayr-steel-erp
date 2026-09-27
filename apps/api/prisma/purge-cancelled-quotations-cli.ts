/* eslint-disable no-console -- script operacional: reporta lo que encuentra y lo que hace. */
/**
 * CLI de la purga de cotizaciones anuladas elegidas por el dueño (D-350).
 *
 * **Dry-run por defecto**: lista cada número con su estado, lo que se borraría, lo que queda
 * bloqueado y por qué, los productos que quedarían sin uso y las claves de PDF que quedarían
 * huérfanas en R2. El informe se guarda además en
 * `local-data/import-compras/purga-cotizaciones-<dry-run|execute>-<rama>.txt`.
 * `--execute` borra en una sola transacción (contra production exige `--confirm-production` y la
 * aprobación del dueño). No toca R2: la CLI corre sin él.
 *
 * Uso (vía `pnpm purge:cancelled-quotations`, que compila con `tsc -p tsconfig.cli.json`):
 *   pnpm purge:cancelled-quotations --numbers COT-000012,COT-000015 [--branch …]
 *   pnpm purge:cancelled-quotations --numbers COT-000012 --branch demo --execute
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../src/audit/audit.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  executeQuotationPurge,
  formatPurgeReport,
  planQuotationPurge,
} from '../src/sales/quotation-purge';
import { assertExecuteAllowed } from './cli-gate';

const execute = process.argv.includes('--execute');

function numbersArg(): string[] {
  const i = process.argv.indexOf('--numbers');
  const raw = i >= 0 ? process.argv[i + 1] : undefined;
  if (raw === undefined || raw.startsWith('--')) {
    throw new Error('Falta --numbers COT-…,COT-… (los números que eligió el dueño).');
  }
  const numbers = raw
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (numbers.length === 0) throw new Error('--numbers vino vacío.');
  return [...new Set(numbers)];
}

function saveReport(report: string): string {
  const branch = process.env.AYR_CLI_BRANCH ?? 'sin-rama';
  // La CLI corre con `cwd` en `apps/api`: `local-data/` está en la raíz del repo (AGENTS §3.3).
  const dir = resolve(process.cwd(), '..', '..', 'local-data', 'import-compras');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `purga-cotizaciones-${execute ? 'execute' : 'dry-run'}-${branch}.txt`);
  writeFileSync(file, `${report}\n`, 'utf8');
  return file;
}

async function main(): Promise<void> {
  assertExecuteAllowed(execute);
  const numbers = numbersArg();
  const branch = process.env.AYR_CLI_BRANCH ?? '(sin declarar)';
  console.error(`Destino: ${branch}`);

  const prisma = new PrismaClient();
  try {
    const plan = await planQuotationPurge(prisma, numbers);
    const header = `Purga de cotizaciones anuladas (D-350) — ${branch} — ${new Date().toISOString()} — ${execute ? 'EXECUTE' : 'dry-run'}\nNúmeros pedidos: ${numbers.join(', ')}`;
    if (!execute) {
      const report = formatPurgeReport(plan, header);
      console.log(report);
      console.log(`\nDry-run: no se escribió nada. Informe: ${saveReport(report)}`);
      return;
    }
    const audit = new AuditService(prisma as unknown as PrismaService);
    const result = await prisma.$transaction(
      (tx) =>
        executeQuotationPurge(
          tx,
          audit,
          numbers,
          plan.purgeable.map((c) => c.code),
        ),
      { timeout: 60_000 },
    );
    const report = formatPurgeReport(
      {
        purgeable: result.purged,
        blocked: result.blocked,
        freedProducts: result.freedProducts,
        orphanPdfKeys: result.orphanPdfKeys,
      },
      header,
    );
    console.log(report);
    console.log(`\nBorradas: ${String(result.purged.length)}. Informe: ${saveReport(report)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
