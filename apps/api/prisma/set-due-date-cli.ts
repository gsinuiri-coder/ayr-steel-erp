/**
 * cc61 (D-699) — **poner el vencimiento de un comprobante al crédito por el servicio de dominio**:
 * `pnpm fix:vencimiento --comprobante <número> --vence <YYYY-MM-DD> [--motivo "<texto>"]`.
 *
 * Usa `InvoicingService.updateDueDateInTx`, la misma puerta que el diálogo del detalle (reglas de
 * `dueDateChangeBlock`: al crédito, vigente, no antes de la emisión, sin NC 13 viva). **Dry-run por
 * defecto**: corre dentro de una transacción que se revierte y comprueba que lo único que cambia es
 * el vencimiento de ese comprobante (`dueDateViolations`) más su fila de auditoría. `--execute` exige
 * una vista previa válida de la misma rama, commit y argumentos (< 24 h), vuelve a comprobar todo
 * dentro de la transacción y, si algo difiere, revierte. La vista previa queda en `local-data/cc61/`
 * (fuera del repo: trae datos reales).
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Role } from '@prisma/client';
import { fromDateOnly, updateDueDateSchema } from '@ayr/shared';
import { AppModule } from '../src/app.module';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import { InvoicingService } from '../src/invoicing/invoicing.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { shaWithChanges, DIRTY_SUFFIX } from '../src/inventory/recost-historic';
import { dueDateViolations, type DueDateFacts } from '../src/invoicing/due-date-change';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--comprobante', '--vence', '--motivo']);
const execute = args.includes('--execute');
const ROOT = resolve(__dirname, '../../../..');

function flag(name: string, required = true): string | undefined {
  const at = args.indexOf(name);
  const value = at === -1 ? undefined : args[at + 1];
  if (value === undefined || value.startsWith('--')) {
    if (required) throw new Error(`${name} es obligatorio`);
    return undefined;
  }
  return value;
}

function assertArgs(): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--execute') continue;
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    throw new Error(`Argumento no reconocido: ${arg}`);
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
  document: string;
  dueDate: string;
  reason: string | null;
  facts: DueDateFacts;
  violations: string[];
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
  const number = flag('--comprobante') ?? '';
  const input = updateDueDateSchema.parse({
    dueDate: flag('--vence'),
    reason: flag('--motivo', false),
  });

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('Falta ADMIN_EMAIL');
  const lookup = new PrismaClient();
  const actor = await lookup.user.findUnique({ where: { email } });
  await lookup.$disconnect();
  if (!actor?.active || actor.role !== Role.ADMINISTRADOR) {
    throw new Error('ADMIN_EMAIL no es administrador activo');
  }

  const outDir = resolve(ROOT, 'local-data/cc61');
  mkdirSync(outDir, { recursive: true });
  const previewPath = resolve(outDir, `vencimiento-VISTA-PREVIA-${branch}.json`);
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
    if (
      previous.document !== number ||
      previous.dueDate !== input.dueDate ||
      previous.reason !== (input.reason ?? null)
    ) {
      throw new Error('--execute rechazado: los argumentos no son los de la vista previa');
    }
    if (previous.violations.length > 0) {
      throw new Error('--execute rechazado: la vista previa no cumple las condiciones');
    }
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  let preview: Preview;
  try {
    const db = app.get(PrismaService);
    const invoicing = app.get(InvoicingService);
    try {
      preview = await db.$transaction(
        async (tx) => {
          const startedAt = new Date();
          const matches = await tx.fiscalDocument.findMany({
            where: { number, archivedAt: null, docType: { in: ['FACTURA', 'BOLETA'] } },
          });
          const doc = matches[0];
          if (!doc || matches.length > 1) {
            throw new Error(`Se esperaba un comprobante ${number} y hay ${String(matches.length)}`);
          }
          const auditBefore = await tx.auditLog.count({ where: { entityId: doc.id } });
          let rejected: string | null = null;
          try {
            await invoicing.updateDueDateInTx(tx, actor, doc.id, input);
          } catch (err) {
            if (!(err instanceof HttpException)) throw err;
            rejected = err.message;
          }
          const after = await tx.fiscalDocument.findUniqueOrThrow({ where: { id: doc.id } });
          const newAudits = await tx.auditLog.findMany({
            where: { entityId: doc.id },
            orderBy: { at: 'asc' },
            skip: auditBefore,
            select: { action: true },
          });
          const otherDocsTouched = await tx.fiscalDocument.count({
            where: { id: { not: doc.id }, updatedAt: { gte: startedAt } },
          });
          const changedFields = (Object.keys(after) as (keyof typeof after)[]).filter(
            (k) => JSON.stringify(after[k]) !== JSON.stringify(doc[k]),
          );
          const facts: DueDateFacts = {
            documentId: doc.id,
            status: doc.status,
            paymentTerms: doc.paymentTerms,
            issueDate: fromDateOnly(doc.issueDate),
            dueDateBefore: doc.dueDate ? fromDateOnly(doc.dueDate) : null,
            dueDateAfter: after.dueDate ? fromDateOnly(after.dueDate) : null,
            changedFields,
            newAuditActions: newAudits.map((a) => a.action),
            otherDocsTouched,
            rejected,
          };
          const p: Preview = {
            branch,
            gitSha: sha,
            generatedAtIso: new Date().toISOString(),
            executed: execute,
            document: number,
            dueDate: input.dueDate,
            reason: input.reason ?? null,
            facts,
            violations: dueDateViolations(facts, input.dueDate),
          };
          if (!execute || p.violations.length > 0) {
            throw new DryRun({ ...p, executed: false });
          }
          return p;
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
    } catch (err) {
      if (!(err instanceof DryRun)) throw err;
      preview = err.preview;
      if (execute) {
        writeFileSync(
          resolve(outDir, `vencimiento-RECHAZADA-${branch}.json`),
          JSON.stringify(preview, null, 2),
        );
        throw new Error(`NO SE ESCRIBIÓ NADA en ${branch}: ${preview.violations.join(' · ')}`);
      }
    }
  } finally {
    await app.close();
  }
  const name = execute ? `vencimiento-EJECUCION-${branch}` : `vencimiento-VISTA-PREVIA-${branch}`;
  writeFileSync(resolve(outDir, `${name}.json`), JSON.stringify(preview, null, 2));
  if (execute) writeFileSync(previewPath, JSON.stringify({ ...previous, executed: true }, null, 2));
  console.error(JSON.stringify(preview, null, 2));
  console.error(
    preview.violations.length === 0
      ? `${execute ? 'EJECUTADO' : 'DRY-RUN'} en ${branch}: cambia solo el vencimiento de ${number}.`
      : `DRY-RUN en ${branch}: NO cumple: ${preview.violations.join(' · ')}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
