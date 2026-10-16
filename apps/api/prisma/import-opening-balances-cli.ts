/**
 * cc56 (D-668) — **saldos iniciales de cobranzas y pagos a proveedor**: `pnpm import:saldos-iniciales`.
 *
 * Tres usos:
 *
 * - `--plantillas [--corte AAAA-MM-DD]`: escribe en `--out` (por defecto `local-data/cc56/plantillas/`)
 *   las dos plantillas vacías, con un ejemplo ficticio, y las dos prellenadas con los comprobantes y
 *   compras vivos de la rama. Solo lee.
 * - `--corte AAAA-MM-DD --faltantes pagado|pendiente [--cobranzas <xlsx>] [--pagos <xlsx>]`: el lote.
 *   **Dry-run por defecto**: registra todo dentro de una transacción que se revierte al final y deja la
 *   vista previa en `--out`. `--execute` exige una vista previa de la misma rama, del mismo commit, de
 *   los mismos archivos y de menos de 24 h, y compara el plan dentro de la transacción antes del commit.
 * - `--deshacer <lote> --motivo "<texto>"`: revierte los pagos del lote (dry-run por defecto).
 *
 * Contra production, el wrapper exige `--confirm-production`; `--execute` además el OK del dueño por
 * nombre (D-460).
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Role } from '@prisma/client';
import { businessToday, isCalendarDate } from '@ayr/shared';
import { AppModule } from '../src/app.module';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import { OperationDateService } from '../src/common/operation-date.service';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReceivablesService } from '../src/invoicing/receivables.service';
import { PurchasesService } from '../src/purchases/purchases.service';
import { shaWithChanges } from '../src/inventory/recost-historic';
import type { RequestUser } from '../src/auth/auth.types';
import {
  OpeningBalancesImporter,
  OpeningBatchRejected,
  type OpeningBatchInput,
} from '../src/imports/opening-balances.service';
import type { MissingPolicy } from '../src/imports/opening-balances-plan';
import {
  customerTemplate,
  readOpeningRows,
  supplierTemplate,
} from '../src/imports/opening-balances-sheets';
import {
  planFingerprint,
  previewRejection,
  renderOpeningPreview,
  type OpeningPreview,
} from '../src/imports/opening-balances-report';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set([
  '--corte',
  '--faltantes',
  '--cobranzas',
  '--pagos',
  '--out',
  '--deshacer',
  '--motivo',
]);
const BOOL_FLAGS = new Set(['--execute', '--plantillas']);

function flag(name: string): string | null {
  const at = args.indexOf(name);
  if (at === -1) return null;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requiere un valor`);
  return value;
}

function assertArgs(): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (BOOL_FLAGS.has(arg)) continue;
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    throw new Error(`Argumento no reconocido: ${arg}`);
  }
}

const execute = args.includes('--execute');
const ROOT = resolve(__dirname, '../../../..');

function gitSha(): string {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: ROOT });
  const porcelain = execFileSync('git', ['status', '--porcelain', '--', 'apps', 'packages'], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  return shaWithChanges(head, porcelain);
}

function hashOf(path: string | null): string | null {
  return path === null ? null : createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** El dry-run registra todo y se lanza esto para revertir la transacción. */
class DryRun extends Error {
  constructor(readonly payload: unknown) {
    super('dry-run');
  }
}

async function adminActor(): Promise<RequestUser> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('Falta ADMIN_EMAIL');
  const lookup = new PrismaClient();
  const user = await lookup.user.findUnique({ where: { email } });
  await lookup.$disconnect();
  if (!user?.active || user.role !== Role.ADMINISTRADOR) {
    throw new Error('ADMIN_EMAIL no es administrador activo');
  }
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    mustChangePassword: false,
    sessionId: 'cli-saldos-iniciales',
  };
}

async function main(): Promise<void> {
  assertArgs();
  assertExecuteAllowed(execute);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  const branch = process.env.AYR_CLI_BRANCH;
  if (!branch) throw new Error('Ejecutá este subcomando mediante runApiCli');
  const outDir = resolve(flag('--out') ?? resolve(ROOT, 'local-data/cc56'));
  const actor = await adminActor();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const db = app.get(PrismaService);
    const importer = new OpeningBalancesImporter(
      app.get(ReceivablesService),
      app.get(PurchasesService),
      app.get(AuditService),
      app.get(OperationDateService).historicalLoadStart,
    );

    if (args.includes('--plantillas')) {
      const cutoff = flag('--corte') ?? businessToday();
      const dir = flag('--out') ? outDir : resolve(outDir, 'plantillas');
      mkdirSync(dir, { recursive: true });
      const customers = await importer.customerAccounts(db, cutoff);
      const suppliers = await importer.supplierAccounts(db, cutoff);
      const files: [string, Buffer][] = [
        ['plantilla-cobranzas-vacia.xlsx', customerTemplate(null, cutoff)],
        ['plantilla-pagos-vacia.xlsx', supplierTemplate(null, cutoff)],
        [`cobranzas-prellenada-${branch}.xlsx`, customerTemplate(customers.template, cutoff)],
        [`pagos-prellenada-${branch}.xlsx`, supplierTemplate(suppliers.template, cutoff)],
      ];
      for (const [name, buffer] of files) writeFileSync(resolve(dir, name), buffer);
      console.error(
        `Plantillas en ${dir}: ${files.map(([n]) => n).join(', ')} ` +
          `(${String(customers.template.length)} comprobantes, ${String(suppliers.template.length)} compras).`,
      );
      return;
    }

    mkdirSync(outDir, { recursive: true });
    const undoBatch = flag('--deshacer');
    if (undoBatch !== null) {
      const reason = flag('--motivo');
      if (!reason || reason.trim().length < 5)
        throw new Error('--deshacer exige --motivo (5 caracteres o más)');
      try {
        const outcome = await db.$transaction(
          async (tx) => {
            const r = await importer.undo(tx, actor, undoBatch, reason.trim());
            if (!execute) throw new DryRun(r);
            return r;
          },
          { timeout: 600_000, maxWait: 30_000 },
        );
        console.error(
          `DESHECHO en ${branch}: lote ${undoBatch}, ${String(outcome.reversed)} pago(s) revertido(s), ` +
            `${String(outcome.alreadyReversed)} ya estaban revertidos.`,
        );
      } catch (err) {
        if (!(err instanceof DryRun)) throw err;
        const r = err.payload as { reversed: number; alreadyReversed: number };
        console.error(
          `DRY-RUN en ${branch}: deshacer el lote ${undoBatch} revertiría ${String(r.reversed)} pago(s) ` +
            `(${String(r.alreadyReversed)} ya revertidos). Nada se escribió.`,
        );
      }
      return;
    }

    const cutoff = flag('--corte');
    if (!cutoff || !isCalendarDate(cutoff)) throw new Error('--corte AAAA-MM-DD es obligatorio');
    if (cutoff > businessToday()) throw new Error('--corte no puede ser futuro');
    const missingFlag = flag('--faltantes');
    const missing: MissingPolicy | null =
      missingFlag === 'pagado' ? 'PAID' : missingFlag === 'pendiente' ? 'PENDING' : null;
    if (missing === null) {
      throw new Error(
        '--faltantes pagado|pendiente es obligatorio: qué hacer con lo que no está en el Excel',
      );
    }
    const customersPath = flag('--cobranzas');
    const suppliersPath = flag('--pagos');
    if (customersPath === null && suppliersPath === null) {
      throw new Error('Falta el Excel: --cobranzas <xlsx> y/o --pagos <xlsx>');
    }
    const input: OpeningBatchInput = {
      cutoff,
      missing,
      customers:
        customersPath === null ? null : readOpeningRows(readFileSync(customersPath), 'CUSTOMERS'),
      suppliers:
        suppliersPath === null ? null : readOpeningRows(readFileSync(suppliersPath), 'SUPPLIERS'),
    };
    const files = { customers: hashOf(customersPath), suppliers: hashOf(suppliersPath) };
    const sha = gitSha();
    const previewPath = resolve(outDir, `saldos-VISTA-PREVIA-${branch}.json`);
    const expected = existsSync(previewPath)
      ? (JSON.parse(readFileSync(previewPath, 'utf8')) as OpeningPreview)
      : null;
    if (execute) {
      const rejection = previewRejection(expected, { branch, gitSha: sha, at: new Date(), files });
      if (rejection !== null) throw new Error(`--execute rechazado: ${rejection}`);
    }

    let preview: OpeningPreview;
    try {
      const result = await db.$transaction(
        async (tx) => {
          const r = await importer.run(tx, actor, input);
          if (!execute) throw new DryRun(r);
          if (expected && planFingerprint(expected.result) !== planFingerprint(r)) {
            throw new Error(
              'NO SE ESCRIBIÓ NADA: el plan de la ejecución no coincide con el de la vista previa (la transacción se revirtió).',
            );
          }
          return r;
        },
        { timeout: 600_000, maxWait: 30_000 },
      );
      preview = {
        branch,
        gitSha: sha,
        generatedAtIso: new Date().toISOString(),
        files,
        result,
        executed: true,
      };
    } catch (err) {
      if (err instanceof OpeningBatchRejected && err.result) {
        preview = {
          branch,
          gitSha: sha,
          generatedAtIso: new Date().toISOString(),
          files,
          result: err.result,
          executed: false,
        };
        const md = renderOpeningPreview(preview);
        writeFileSync(resolve(outDir, `saldos-RECHAZADO-${branch}.md`), md);
        console.error(md);
        throw new Error(
          `${err.message} Detalle en ${resolve(outDir, `saldos-RECHAZADO-${branch}.md`)}`,
        );
      }
      if (!(err instanceof DryRun)) throw err;
      preview = {
        branch,
        gitSha: sha,
        generatedAtIso: new Date().toISOString(),
        files,
        result: err.payload as OpeningPreview['result'],
        executed: false,
      };
    }
    const name = execute
      ? `saldos-EJECUCION-${branch}-${preview.result.batchId.slice(0, 8)}`
      : `saldos-VISTA-PREVIA-${branch}`;
    writeFileSync(resolve(outDir, `${name}.json`), JSON.stringify(preview, null, 2));
    writeFileSync(resolve(outDir, `${name}.md`), renderOpeningPreview(preview));
    console.error(renderOpeningPreview(preview));
    console.error(
      execute
        ? `EJECUTADO en ${branch}: lote ${preview.result.batchId}. Para deshacerlo: --deshacer ${preview.result.batchId} --motivo "<texto>".`
        : `DRY-RUN en ${branch}: nada se escribió (la transacción se revirtió). Vista previa en ${resolve(outDir, `${name}.md`)}.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
