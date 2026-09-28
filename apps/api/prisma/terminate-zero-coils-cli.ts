/**
 * CLI de la terminación única de bobinas vigentes en 0 kg (D-360).
 *
 * Contexto de Nest y funciones de dominio (`src/coils/terminate-zero-coils.ts`, la misma regla
 * que la terminación automática en línea), nunca SQL directo. **Dry-run por defecto**, en una
 * transacción `READ ONLY`: la lista de las que se terminarían y de las omitidas con su motivo,
 * a `local-data/c06/terminar-cero-dry-run-<rama>.txt`. `--execute` genera un **lote**
 * (`batchId`) y termina todo en una transacción, con la lista a
 * `local-data/c06/terminar-cero-execute-<rama>-<lote>.txt`. `--undo <lote>` reabre exactamente
 * las bobinas de esa corrida (dry-run sin `--execute`).
 *
 * Uso (vía `pnpm terminate:zero-coils`, que compila con `tsc -p tsconfig.cli.json`):
 *   pnpm terminate:zero-coils [--branch local|local-e2e|dev|demo|production]
 *   pnpm terminate:zero-coils --execute --branch production --confirm-production
 *   pnpm terminate:zero-coils --undo <lote> [--execute] --branch production --confirm-production
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Role } from '@prisma/client';
import { businessToday } from '@ayr/shared';
import { AppModule } from '../src/app.module';
import { AuditService } from '../src/audit/audit.service';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import {
  coilsOfBatch,
  executeTerminateZeroCoils,
  formatSnapshot,
  formatTerminatePlan,
  formatUndo,
  planTerminateZeroCoils,
  planUndoTerminateZeroCoils,
  snapshotCoils,
  undoTerminateZeroCoils,
} from '../src/coils/terminate-zero-coils';
import { PrismaService } from '../src/prisma/prisma.service';
import { assertExecuteAllowed } from './cli-gate';

const execute = process.argv.includes('--execute');
const undoFlag = process.argv.indexOf('--undo');
const undoBatch = undoFlag === -1 ? undefined : process.argv[undoFlag + 1];
const reportFlag = process.argv.indexOf('--report');
const reportBatch = reportFlag === -1 ? undefined : process.argv[reportFlag + 1];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function save(name: string, text: string): string {
  const dir = resolve(__dirname, '../../../../local-data/c06');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, name);
  writeFileSync(file, text);
  return file;
}

async function main(): Promise<void> {
  assertExecuteAllowed(execute);
  const branch = process.env.AYR_CLI_BRANCH ?? '(sin declarar)';
  console.error(`Destino: ${branch}`);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  if (undoFlag !== -1 && (undoBatch === undefined || !UUID.test(undoBatch))) {
    throw new Error('--undo necesita el lote de la corrida (un UUID)');
  }
  if (reportFlag !== -1 && (reportBatch === undefined || !UUID.test(reportBatch))) {
    throw new Error('--report necesita el lote de la corrida (un UUID)');
  }
  if (reportFlag !== -1 && execute) throw new Error('--report es de solo lectura: sin --execute');

  const prisma = new PrismaClient();
  const actorEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!actorEmail) throw new Error('Falta ADMIN_EMAIL en el entorno');
  const actorUser = await prisma.user.findUnique({ where: { email: actorEmail } });
  await prisma.$disconnect();
  if (!actorUser || !actorUser.active || actorUser.role !== Role.ADMINISTRADOR) {
    throw new Error(`${actorEmail} no es un ADMINISTRADOR activo en esta rama`);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const db = app.get(PrismaService);
    const audit = app.get(AuditService);
    const operationDate = businessToday();

    // Foto de solo lectura de las bobinas de un lote: después del lote, o después del --undo.
    if (reportBatch !== undefined) {
      const text = await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          const coils = await coilsOfBatch(tx, reportBatch);
          return formatSnapshot(
            await snapshotCoils(
              tx,
              coils.map((c) => c.id),
            ),
            `lote ${reportBatch} — rama ${branch}`,
          );
        },
        { timeout: 120_000 },
      );
      console.warn(text);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      console.warn(
        `Foto en ${save(`terminar-cero-foto-${branch}-${reportBatch}-${stamp}.txt`, text)}`,
      );
      return;
    }

    if (undoBatch !== undefined) {
      if (!execute) {
        const plan = await db.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            return planUndoTerminateZeroCoils(tx, undoBatch);
          },
          { timeout: 120_000 },
        );
        const text = formatUndo(plan, { branch, mode: 'dry-run', batchId: undoBatch });
        console.warn(text);
        console.warn(
          `Lista en ${save(`terminar-cero-undo-dry-run-${branch}-${undoBatch}.txt`, text)}`,
        );
        console.warn('Dry-run: no se escribió nada.');
        return;
      }
      const done = await db.$transaction(
        (tx) =>
          undoTerminateZeroCoils(tx, audit, {
            actorId: actorUser.id,
            batchId: undoBatch,
            operationDate,
          }),
        { timeout: 120_000 },
      );
      const text = formatUndo(done, { branch, mode: 'ejecutado', batchId: undoBatch });
      console.warn(text);
      console.warn(`Lista en ${save(`terminar-cero-undo-${branch}-${undoBatch}.txt`, text)}`);
      return;
    }

    if (!execute) {
      const plan = await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          const found = await planTerminateZeroCoils(tx);
          // La foto «antes»: las que se terminarían, con su saldo y su kardex.
          const before = await snapshotCoils(
            tx,
            found.terminate.map((c) => c.id),
          );
          return { found, before };
        },
        { timeout: 120_000 },
      );
      const text = `${formatTerminatePlan(plan.found, { branch, mode: 'dry-run' })}\n${formatSnapshot(plan.before, `antes — rama ${branch}`)}`;
      console.warn(text);
      console.warn(`Lista en ${save(`terminar-cero-dry-run-${branch}.txt`, text)}`);
      console.warn('Dry-run: no se escribió nada.');
      return;
    }

    const batchId = randomUUID();
    const done = await db.$transaction(
      (tx) =>
        executeTerminateZeroCoils(tx, audit, { actorId: actorUser.id, batchId, operationDate }),
      { timeout: 120_000 },
    );
    const text = formatTerminatePlan(done, { branch, mode: 'ejecutado', batchId });
    console.warn(text);
    console.warn(`Lista en ${save(`terminar-cero-execute-${branch}-${batchId}.txt`, text)}`);
    console.warn(
      `Foto: pnpm terminate:zero-coils --report ${batchId} --branch ${branch}${branch === 'production' ? ' --confirm-production' : ''}`,
    );
    console.warn(
      `Reversa: pnpm terminate:zero-coils --undo ${batchId} --execute --branch ${branch}${branch === 'production' ? ' --confirm-production' : ''}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
