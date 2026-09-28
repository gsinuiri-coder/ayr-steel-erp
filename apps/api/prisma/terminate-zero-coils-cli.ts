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
  executeTerminateZeroCoils,
  formatTerminatePlan,
  formatUndo,
  planTerminateZeroCoils,
  planUndoTerminateZeroCoils,
  undoTerminateZeroCoils,
} from '../src/coils/terminate-zero-coils';
import { PrismaService } from '../src/prisma/prisma.service';
import { assertExecuteAllowed } from './cli-gate';

const execute = process.argv.includes('--execute');
const undoFlag = process.argv.indexOf('--undo');
const undoBatch = undoFlag === -1 ? undefined : process.argv[undoFlag + 1];
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

    if (undoBatch !== undefined) {
      if (!execute) {
        const plan = await db.$transaction(async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          return planUndoTerminateZeroCoils(tx, undoBatch);
        });
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
      const plan = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return planTerminateZeroCoils(tx);
      });
      const text = formatTerminatePlan(plan, { branch, mode: 'dry-run' });
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
      `Reversa: pnpm terminate:zero-coils --undo ${batchId} --execute --branch ${branch}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
