/** Corrección conservadora y reversible de fechas recibidas; dry-run por defecto. */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Role } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import { PrismaService } from '../src/prisma/prisma.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { AuditService } from '../src/audit/audit.service';
import {
  executePurchaseReceivedDates,
  planPurchaseReceivedDates,
  undoPurchaseReceivedDates,
  selectSafeCases,
  type ReceivedDateCase,
} from '../src/purchases/purchase-received-date-fix';

const execute = process.argv.includes('--execute');
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const positions = args.flatMap((arg, i) => (arg === name ? [i] : []));
  if (positions.length > 1) throw new Error(`${name} repetido`);
  const position = positions[0];
  if (position === undefined) return undefined;
  const value = args[position + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requiere valor`);
  return value;
};
const batch = flag('--batch');
const undo = flag('--undo');
const only = flag('--only')?.split(',');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const branch = process.env.AYR_CLI_BRANCH ?? 'desconocida';
const planPath = resolve(__dirname, `../../../../local-data/fechas-recibidas-${branch}.json`);

interface SavedPlan {
  batchId: string;
  branch: string;
  cases: ReceivedDateCase[];
  selectedIds: string[];
}

function printCases(cases: readonly ReceivedDateCase[]): void {
  for (const c of cases) {
    console.warn(`${c.safe ? 'SEGURO' : 'EXCLUIDO'} ${c.document} (${c.purchaseId})`);
    console.warn(
      `  ANTES: recibida ${c.currentReceivedAt}; kardex ${c.currentDate}; ${c.items.map((i) => `${i.key} ${i.qty}`).join(', ')}`,
    );
    console.warn(
      `  DESPUÉS: recibida ${c.destinationDate}; kardex ${c.destinationDate}; cantidades y costos de entrada iguales`,
    );
    if (c.reasons.length) console.warn(`  MOTIVO: ${c.reasons.join('; ')}`);
  }
  console.warn(
    `Total ${cases.length}; seguro ${cases.filter((c) => c.safe).length}; excluido ${cases.filter((c) => !c.safe).length}`,
  );
}

async function main(): Promise<void> {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') continue;
    if (arg === '--batch' || arg === '--undo' || arg === '--only') {
      i++;
      continue;
    }
    throw new Error(`Argumento no reconocido: ${arg ?? ''}`);
  }
  assertExecuteAllowed(execute);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  if (batch && !UUID.test(batch)) throw new Error('--batch necesita UUID');
  if (undo && !UUID.test(undo)) throw new Error('--undo necesita batchId UUID');
  if (undo && batch) throw new Error('--undo y --batch son excluyentes');
  if (undo && only) throw new Error('--undo y --only son excluyentes');
  if (only?.some((id) => !UUID.test(id)))
    throw new Error('--only necesita UUID separados por coma');
  const actorEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!actorEmail) throw new Error('Falta ADMIN_EMAIL');
  const lookup = new PrismaClient();
  const actor = await lookup.user.findUnique({ where: { email: actorEmail } });
  await lookup.$disconnect();
  if (!actor || !actor.active || actor.role !== Role.ADMINISTRADOR)
    throw new Error('ADMIN_EMAIL no es administrador activo');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const db = app.get(PrismaService);
    const inventory = app.get(InventoryService);
    const audit = app.get(AuditService);
    if (undo) {
      if (!execute) {
        const logs = await db.auditLog.findMany({
          where: {
            action: 'purchases.received-date-fix',
            after: { path: ['batchId'], equals: undo },
          },
          select: { entityId: true },
        });
        console.warn(`Undo dry-run lote ${undo}: ${logs.length} compras; no se escribió nada.`);
        return;
      }
      const ids = await db.$transaction(
        (tx) => undoPurchaseReceivedDates(tx, inventory, audit, actor.id, undo),
        { timeout: 300_000 },
      );
      console.warn(
        `Undo ejecutado ${undo}: ${ids.length} compras restauradas (${ids.join(', ')}).`,
      );
      return;
    }
    if (!execute) {
      const cases = await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          return planPurchaseReceivedDates(tx);
        },
        { timeout: 120_000 },
      );
      const batchId = batch ?? randomUUID();
      const selectedIds = selectSafeCases(cases, only).map((c) => c.purchaseId);
      mkdirSync(resolve(planPath, '..'), { recursive: true });
      writeFileSync(
        planPath,
        JSON.stringify({ batchId, branch, cases, selectedIds } satisfies SavedPlan, null, 2),
      );
      console.warn(`DRY-RUN rama ${branch}; batchId ${batchId}; plan ${planPath}`);
      printCases(cases);
      console.warn(`Seleccionadas para ejecutar: ${selectedIds.join(', ')}`);
      console.warn('No se escribió en la base.');
      return;
    }
    const saved = JSON.parse(readFileSync(planPath, 'utf8')) as SavedPlan;
    if (
      saved.branch !== branch ||
      (batch && saved.batchId !== batch) ||
      (only && JSON.stringify(only) !== JSON.stringify(saved.selectedIds))
    )
      throw new Error('Plan de otra rama, lote o selección');
    const done = await db.$transaction(
      (tx) =>
        executePurchaseReceivedDates(
          tx,
          inventory,
          audit,
          actor.id,
          saved.batchId,
          saved.cases,
          saved.selectedIds,
        ),
      { timeout: 300_000 },
    );
    console.warn(`Ejecutado batchId ${saved.batchId}: ${done.length} compras seguras.`);
    printCases(done);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
