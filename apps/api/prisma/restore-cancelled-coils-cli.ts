/**
 * D-375: restaurar en lote bobinas anuladas que vinieron de una compra. Dry-run por defecto.
 *
 *   dry-run:  --only <id,id>            (guarda el plan con su batchId en local-data/)
 *   execute:  --execute --batch <uuid>  (reclasifica dentro de la transacción; si el modo o la
 *                                        fecha de alguna cambió respecto del plan, aborta)
 *   undo:     --undo <batchId> [--execute]
 *
 * Contra producción, `runApiCli` exige `--confirm-production` (y `--execute` además el OK del
 * dueño). Todo pasa por `InventoryService` y la auditoría; no hay SQL directo.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Role } from '@prisma/client';
import type { CoilRestorePlanDto } from '@ayr/shared';
import { AppModule } from '../src/app.module';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import { PrismaService } from '../src/prisma/prisma.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { AuditService } from '../src/audit/audit.service';
import { OperationDateService } from '../src/common/operation-date.service';
import {
  classifyCoilRestore,
  loadRestoreContext,
  planCoilRestores,
  restoreCoilInTx,
  toPlanDto,
  undoCoilRestoreBatch,
} from '../src/coils/coil-restore';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const flag = (name: string): string | undefined => {
  const positions = args.flatMap((arg, i) => (arg === name ? [i] : []));
  if (positions.length > 1) throw new Error(`${name} repetido`);
  const position = positions[0];
  if (position === undefined) return undefined;
  const value = args[position + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requiere valor`);
  return value;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const branch = process.env.AYR_CLI_BRANCH ?? 'desconocida';
const planPath = resolve(__dirname, `../../../../local-data/restaurar-bobinas-${branch}.json`);

interface SavedPlan {
  batchId: string;
  branch: string;
  reason: string;
  selected: CoilRestorePlanDto[];
}

function print(plans: readonly CoilRestorePlanDto[]): void {
  for (const p of plans) {
    console.warn(
      `${p.mode.padEnd(11)} ${p.code} | ${p.purchaseDocument ?? '—'} (${p.purchaseStatus ?? '—'}) | ${p.qty ?? '—'} kg a ${p.unitCostPen ?? '—'} PEN/kg | entrada original ${p.originalDate ?? '—'} → ${p.date ?? 'no se restaura'}${p.reasons.length ? ` | ${p.reasons.join('; ')}` : ''}`,
    );
  }
}

async function main(): Promise<void> {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') continue;
    if (arg === '--batch' || arg === '--undo' || arg === '--only' || arg === '--reason') {
      i++;
      continue;
    }
    throw new Error(`Argumento no reconocido: ${arg ?? ''}`);
  }
  assertExecuteAllowed(execute);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  const batch = flag('--batch');
  const undo = flag('--undo');
  const only = flag('--only')?.split(',');
  const reason = flag('--reason');
  if (batch && !UUID.test(batch)) throw new Error('--batch necesita UUID');
  if (undo && !UUID.test(undo)) throw new Error('--undo necesita batchId UUID');
  if (undo && (batch || only)) throw new Error('--undo va solo');
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
    const floor = app.get(OperationDateService).historicalLoadStart;

    if (undo) {
      if (!execute) {
        const logs = await db.auditLog.count({
          where: { action: 'coils.restore', after: { path: ['batchId'], equals: undo } },
        });
        console.warn(`Undo dry-run lote ${undo}: ${String(logs)} bobina(s); no se escribió nada.`);
        return;
      }
      if (!reason) throw new Error('--undo --execute exige --reason');
      const ids = await db.$transaction(
        (tx) => undoCoilRestoreBatch(tx, inventory, audit, actor.id, undo, reason),
        { timeout: 120_000 },
      );
      console.warn(`Undo ejecutado ${undo}: ${String(ids.length)} bobina(s) vuelven a anuladas.`);
      return;
    }

    if (!execute) {
      if (!reason)
        throw new Error('El dry-run exige --reason (queda en el plan y en la auditoría)');
      const plans = await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          return planCoilRestores(tx, floor);
        },
        { timeout: 120_000 },
      );
      const selected = plans.filter(
        (p) => p.mode !== 'BLOQUEADA' && (!only || only.includes(p.coilId)),
      );
      if (only && selected.length !== only.length) {
        throw new Error('Alguna bobina de --only no existe, no está anulada o está bloqueada');
      }
      const batchId = batch ?? randomUUID();
      mkdirSync(resolve(planPath, '..'), { recursive: true });
      writeFileSync(
        planPath,
        JSON.stringify({ batchId, branch, reason, selected } satisfies SavedPlan, null, 2),
      );
      console.warn(`DRY-RUN rama ${branch}; batchId ${batchId}; plan ${planPath}`);
      console.warn('Todas las bobinas anuladas de compra:');
      print(plans);
      console.warn(`Seleccionadas para restaurar (${String(selected.length)}):`);
      print(selected);
      console.warn('No se escribió en la base.');
      return;
    }

    const saved = JSON.parse(readFileSync(planPath, 'utf8')) as SavedPlan;
    if (saved.branch !== branch || !batch || saved.batchId !== batch) {
      throw new Error('Plan de otra rama o lote: corré un dry-run y pasá su --batch');
    }
    if (saved.selected.length === 0) throw new Error('El plan no tiene bobinas seleccionadas');
    const done = await db.$transaction(
      async (tx) => {
        const results = [];
        for (const planned of saved.selected) {
          // El plan se congeló en el dry-run: si cambió, no se ejecuta nada del lote.
          const { ctx, coil } = await loadRestoreContext(tx, planned.coilId, floor, true);
          const now = toPlanDto(coil, classifyCoilRestore(ctx));
          const same = (['mode', 'date', 'originalDate', 'qty', 'unitCostPen'] as const).every(
            (k) => now[k] === planned[k],
          );
          if (!same) {
            throw new Error(
              `${planned.code} cambió desde el dry-run (${planned.mode} ${planned.date ?? ''} → ${now.mode} ${now.date ?? ''}): no se ejecuta el lote`,
            );
          }
          results.push(
            await restoreCoilInTx(tx, inventory, audit, {
              actorId: actor.id,
              coilId: planned.coilId,
              reason: saved.reason,
              batchId: saved.batchId,
              historicalFloor: floor,
            }),
          );
        }
        return results;
      },
      { timeout: 120_000 },
    );
    console.warn(
      `Ejecutado batchId ${saved.batchId}: ${String(done.length)} bobina(s) restauradas.`,
    );
    for (const r of done) {
      console.warn(`${r.mode} ${r.code} → ${r.date ?? ''} (movimiento ${r.movementId})`);
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
