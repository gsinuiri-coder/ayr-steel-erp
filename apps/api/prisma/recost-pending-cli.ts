/**
 * cc63 (RC-01 de audit-02) — **completar los recosteos por fecha pendientes**:
 * `pnpm recosteo:pendientes [--branch <rama>] [--execute]`.
 *
 * Lee las marcas `inventory.recost-pending` sin su «resuelto» y recostea cada ítem (producto o
 * bobina) desde su primera fila por la puerta de siempre (`completePendingRecosts`). **Dry-run por
 * defecto**: corre dentro de una transacción que se revierte y dice qué ítems, cuántos ajustes y el
 * cambio de costo total. `--execute` exige una vista previa de la misma rama y commit (< 24 h) con
 * las mismas marcas; si al ejecutar el resultado difiere, revierte. La vista previa queda en
 * `local-data/recosteo-pendientes/` (fuera del repo).
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Role } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import { AuditService } from '../src/audit/audit.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { shaWithChanges, DIRTY_SUFFIX } from '../src/inventory/recost-historic';
import { completePendingRecosts, type CompletedRecosts } from '../src/inventory/recost-pending';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const ROOT = resolve(__dirname, '../../../..');

function assertArgs(): void {
  for (const arg of args) {
    if (arg !== '--execute') throw new Error(`Argumento no reconocido: ${arg}`);
  }
}

function gitSha(): string {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: ROOT });
  const porcelain = execFileSync('git', ['status', '--porcelain', '--', 'apps', 'packages'], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  return shaWithChanges(head, porcelain);
}

interface Preview {
  branch: string;
  gitSha: string;
  generatedAtIso: string;
  executed: boolean;
  result: CompletedRecosts;
  ms: number;
}

class DryRun extends Error {
  constructor(readonly preview: Preview) {
    super('dry-run');
  }
}

async function main(): Promise<void> {
  assertArgs();
  assertExecuteAllowed(execute);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  const branch = process.env.AYR_CLI_BRANCH;
  if (!branch) throw new Error('Ejecuta este subcomando mediante runApiCli');

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('Falta ADMIN_EMAIL');
  const lookup = new PrismaClient();
  const actor = await lookup.user.findUnique({ where: { email } });
  await lookup.$disconnect();
  if (!actor?.active || actor.role !== Role.ADMINISTRADOR) {
    throw new Error('ADMIN_EMAIL no es administrador activo');
  }

  const outDir = resolve(ROOT, 'local-data/recosteo-pendientes');
  mkdirSync(outDir, { recursive: true });
  const previewPath = resolve(outDir, `VISTA-PREVIA-${branch}.json`);
  const sha = gitSha();
  const previous = existsSync(previewPath)
    ? (JSON.parse(readFileSync(previewPath, 'utf8')) as Preview)
    : null;
  if (execute) {
    if (!previous || previous.executed || previous.branch !== branch) {
      throw new Error('--execute rechazado: no hay vista previa de esta rama (corre el dry-run)');
    }
    if (previous.gitSha !== sha || sha.endsWith(DIRTY_SUFFIX)) {
      throw new Error(
        `--execute rechazado: la vista previa es del commit ${previous.gitSha} y el checkout está en ${sha}`,
      );
    }
    if (Date.now() - new Date(previous.generatedAtIso).getTime() > 24 * 3_600_000) {
      throw new Error('--execute rechazado: la vista previa tiene más de 24 h');
    }
    if (previous.result.pendingAuditIds.length === 0) {
      throw new Error('--execute rechazado: la vista previa no tenía nada pendiente');
    }
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  let preview: Preview;
  try {
    const db = app.get(PrismaService);
    const inventory = app.get(InventoryService);
    const audit = app.get(AuditService);
    const started = Date.now();
    try {
      preview = await db.$transaction(
        async (tx) => {
          const result = await completePendingRecosts(
            tx,
            {
              recostForward: (t, seeds, ctx) => inventory.recostForward(t, seeds, ctx),
              write: (t, entry) => audit.write(t, entry),
            },
            actor.id,
          );
          const p: Preview = {
            branch,
            gitSha: sha,
            generatedAtIso: new Date().toISOString(),
            executed: execute,
            result,
            ms: Date.now() - started,
          };
          const same =
            previous !== null &&
            JSON.stringify(previous.result.pendingAuditIds) ===
              JSON.stringify(result.pendingAuditIds) &&
            previous.result.adjusts === result.adjusts &&
            previous.result.deltaPen === result.deltaPen;
          if (!execute || !same) throw new DryRun({ ...p, executed: false });
          return p;
        },
        { timeout: 30 * 60_000, maxWait: 30_000 },
      );
    } catch (err) {
      if (!(err instanceof DryRun)) throw err;
      preview = err.preview;
      if (execute) {
        writeFileSync(resolve(outDir, `RECHAZADA-${branch}.json`), JSON.stringify(preview, null, 2));
        throw new Error(
          `NO SE ESCRIBIÓ NADA en ${branch}: el resultado no coincide con la vista previa (corre el dry-run otra vez)`,
        );
      }
    }
  } finally {
    await app.close();
  }
  const name = execute ? `EJECUCION-${branch}` : `VISTA-PREVIA-${branch}`;
  writeFileSync(resolve(outDir, `${name}.json`), JSON.stringify(preview, null, 2));
  if (execute) writeFileSync(previewPath, JSON.stringify({ ...previous, executed: true }, null, 2));
  console.error(JSON.stringify(preview, null, 2));
  const r = preview.result;
  console.error(
    r.pendingAuditIds.length === 0
      ? `Sin recosteos pendientes en ${branch}.`
      : `${execute ? 'EJECUTADO' : 'DRY-RUN'} en ${branch}: ${String(r.pendingAuditIds.length)} pendiente(s), ${String(r.items.length)} ítem(s), ${String(r.adjusts)} ajuste(s), cambio de costo ${r.deltaPen}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
