/** Inventario de comprobantes sin despacho: lectura transaccional, sin modo execute. */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_HISTORICAL_LOAD_START } from '@ayr/shared';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import { OperationDateService } from '../src/common/operation-date.service';
import type { Env } from '../src/config/env';
import { InvoiceDispatchService } from '../src/invoicing/invoice-dispatch.service';
import { assertInspectionArgs, inspectUndispatchedInvoices } from '../src/invoicing/undispatched-inventory';
import type { PrismaService } from '../src/prisma/prisma.service';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  assertInspectionArgs(args);
  assertExecuteAllowed(false);
  assertExternalOutputsOff(process.env, (line) => { console.error(line); });
  const branch = process.env.AYR_CLI_BRANCH;
  if (!branch) throw new Error('Ejecutá este subcomando mediante runApiCli');

  const db = new PrismaClient();
  try {
    // buildPlan usa solamente OperationDateService; no se inicializa AppModule ni jobs.
    const operationDate = new OperationDateService({
      HISTORICAL_LOAD_START: process.env.HISTORICAL_LOAD_START ?? DEFAULT_HISTORICAL_LOAD_START,
    } as Env);
    const dispatch = new InvoiceDispatchService(
      db as unknown as PrismaService,
      undefined as never,
      undefined as never,
      operationDate,
    );
    const inspection = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return inspectUndispatchedInvoices(tx, dispatch, branch);
    }, { timeout: 300_000 });

    console.warn(`Rama ${inspection.branch}; foto ${inspection.snapshotUtc}; transacción READ ONLY`);
    console.warn('Estado | Comprobantes | Pendientes D-285 | Sin despacho declarado');
    for (const c of inspection.counts)
      console.warn(`${c.status} | ${c.documents} | ${c.pending} | ${c.withoutDeclaredDispatch}`);
    console.warn('\nComprobante | Fecha | Estado | Líneas sin despacho | Veredicto | Compras a mover');
    if (inspection.rows.length === 0) console.warn('(ninguno)');
    for (const row of inspection.rows) {
      const lines = row.lines.map((line) =>
        `${line.sku} ${line.qty} [${line.action} ${line.operationDate}${line.reason ? `: ${line.reason}` : ''}]`).join('; ');
      const purchases = row.purchases.map((p) => `${p.document} (${p.id})`).join(', ');
      console.warn(`${row.number} | ${row.issueDate} | ${row.status} | ${lines} | ${row.verdict} | ${purchases || '—'}`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
