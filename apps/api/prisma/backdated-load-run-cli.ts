/**
 * cc64 (D-705, D-706) — **el cargador de la carga atrasada**:
 *   `pnpm carga:ejecutar --archivo <plan.xlsx> --lote <id> [--hasta <paso>] [--execute]`
 *   `pnpm carga:revertir --lote <id> [--execute]`
 *
 * Dry-run por defecto: dice qué haría (y qué ya está hecho en ese lote) sin escribir nada. Con
 * `--execute` escribe por los servicios de dominio (`BackdatedLoadRunner`). Contra producción hace
 * falta además `--confirm-production` (lo exige `runApiCli`) y el OK del dueño por nombre (D-460).
 *
 * La primera ejecución de un lote corre antes `carga:revisar` sobre todo el plan: con un solo error
 * (un negativo, una fecha, un comprobante fuera de los 90 días) no escribe nada. Al reanudar, el
 * archivo tiene que ser el mismo (se compara su huella); uno corregido va con otro `--lote`.
 * El informe queda en `local-data/carga-atrasada/` (fuera del repo: trae datos del negocio).
 */
import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Role } from '@prisma/client';
import { businessToday, DEFAULT_HISTORICAL_LOAD_START, isCalendarDate } from '@ayr/shared';
import { AppModule } from '../src/app.module';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import type { RequestUser } from '../src/auth/auth.types';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PurchaseImportService } from '../src/imports/purchase-import.service';
import { PurchasesService } from '../src/purchases/purchases.service';
import { QuotationImportService } from '../src/imports/quotation-import.service';
import { QuotationsService } from '../src/sales/quotations.service';
import { SalesOrdersService } from '../src/sales/sales-orders.service';
import { RoofingProductionService } from '../src/production/roofing-production.service';
import { DispatchesService } from '../src/invoicing/dispatches.service';
import { InvoicingService } from '../src/invoicing/invoicing.service';
import { FiscalImportService } from '../src/invoicing/fiscal-import.service';
import { ReceivablesService } from '../src/invoicing/receivables.service';
import { listPendingRecosts } from '../src/inventory/recost-pending';
import { reviewBackdatedLoad } from '../src/imports/backdated-load';
import {
  loadReviewContext,
  readLoadSheets,
  reviewMarkdown,
} from '../src/imports/backdated-load-context';
import {
  LOAD_STEP_LABELS,
  LOAD_STEPS,
  planLoadOps,
  type LoadOp,
  type LoadStep,
} from '../src/imports/backdated-load-ops';
import {
  BackdatedLoadRunner,
  readManifest,
  type LoadManifest,
  type LoadRunResult,
} from '../src/imports/backdated-load-runner';

const args = process.argv.slice(2);
const mode = args[0];
const execute = args.includes('--execute');
const ROOT = resolve(__dirname, '../../../..');
const STEP_ALIASES: Record<string, LoadStep> = {
  compras: 'purchases',
  ventas: 'sales',
  pedidos: 'orders',
  produccion: 'production',
  despachos: 'dispatches',
  comprobantes: 'invoices',
  cobros: 'collections',
  pagos: 'supplierPayments',
};

function flag(name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requiere un valor`);
  return value;
}

function assertArgs(): void {
  if (mode !== 'ejecutar' && mode !== 'revertir') {
    throw new Error('Uso: carga:ejecutar … | carga:revertir …');
  }
  const known = new Set(['--archivo', '--lote', '--hasta', '--fecha-carga']);
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i] ?? '';
    if (a === '--execute') continue;
    if (!known.has(a)) throw new Error(`Argumento no reconocido: ${a}`);
    i += 1;
  }
}

function lines(title: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : [`## ${title}`, '', ...items.map((x) => `- ${x}`), ''];
}

function stepTable(ops: readonly LoadOp[], manifest: LoadManifest): string[] {
  return [
    '| Paso | Operaciones | Ya hechas en el lote | Faltan |',
    '| --- | --- | --- | --- |',
    ...LOAD_STEPS.map((s) => {
      const of = ops.filter((o) => o.step === s);
      const done = of.filter((o) => manifest.done.has(o.key)).length;
      return `| ${LOAD_STEP_LABELS[s]} | ${String(of.length)} | ${String(done)} | ${String(of.length - done)} |`;
    }),
    '',
  ];
}

function resultLines(r: LoadRunResult | null): string[] {
  if (!r) return [];
  const out = [
    `Hechas en esta corrida: ${String(r.executed.length)} · saltadas (ya estaban): ${String(r.skipped.length)} · ${(r.ms / 1000).toFixed(1)} s`,
    '',
  ];
  if (r.failure) {
    out.push(
      '## Se detuvo',
      '',
      `- Operación: \`${r.failure.key}\` (${LOAD_STEP_LABELS[r.failure.step]})`,
      `- Filas: ${r.failure.rows.map((x) => `${x.sheet} ${String(x.row)}`).join(', ') || '—'}`,
      `- Motivo: ${r.failure.message}`,
      '',
      'Lo hecho hasta ahí queda en el lote: corrige y vuelve a correr el mismo comando para seguir.',
      '',
    );
  }
  return out;
}

async function main(): Promise<void> {
  assertArgs();
  assertExecuteAllowed(execute);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  const branch = process.env.AYR_CLI_BRANCH;
  if (!branch) throw new Error('Ejecuta este subcomando mediante runApiCli');
  const batchId = flag('--lote');
  if (!batchId || !/^[A-Za-z0-9._-]{3,60}$/.test(batchId)) {
    throw new Error('--lote es obligatorio: letras, números, «.», «_» o «-» (3 a 60)');
  }

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('Falta ADMIN_EMAIL');
  const lookup = new PrismaClient();
  const user = await lookup.user.findUnique({ where: { email } });
  await lookup.$disconnect();
  if (!user?.active || user.role !== Role.ADMINISTRADOR) {
    throw new Error('ADMIN_EMAIL no es administrador activo');
  }
  const actor: RequestUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: Role.ADMINISTRADOR,
    mustChangePassword: false,
    sessionId: randomUUID(),
  };

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  const report: string[] = [];
  let failed = false;
  try {
    const prisma = app.get(PrismaService);
    const runner = new BackdatedLoadRunner(
      {
        prisma,
        audit: app.get(AuditService),
        purchaseImport: app.get(PurchaseImportService),
        purchases: app.get(PurchasesService),
        quotationImport: app.get(QuotationImportService),
        quotations: app.get(QuotationsService),
        salesOrders: app.get(SalesOrdersService),
        roofing: app.get(RoofingProductionService),
        dispatches: app.get(DispatchesService),
        invoicing: app.get(InvoicingService),
        fiscalImport: app.get(FiscalImportService),
        receivables: app.get(ReceivablesService),
      },
      actor,
      batchId,
    );
    const manifest = await readManifest(prisma, batchId);

    if (mode === 'revertir') {
      const todo = [...manifest.done.keys()].reverse();
      report.push(
        `# Reversa del lote ${batchId} (${branch})`,
        '',
        `${execute ? 'EJECUCIÓN' : 'DRY-RUN'}: ${String(todo.length)} operaciones por revertir, de la última a la primera.`,
        '',
        ...lines('Orden', todo),
      );
      if (execute && todo.length > 0) {
        const result = await runner.revert(manifest);
        report.push(...resultLines(result));
        failed = result.failure !== null;
      }
      return;
    }

    const file = flag('--archivo');
    if (!file) throw new Error('Falta --archivo <plan.xlsx>');
    const buffer = readFileSync(file);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    if (manifest.start && manifest.start.sha256 !== sha256) {
      throw new Error(
        `El lote ${batchId} se empezó con otro archivo (${manifest.start.fileName}): un plan corregido va con otro --lote`,
      );
    }
    const loadDate = flag('--fecha-carga') ?? businessToday();
    if (!isCalendarDate(loadDate)) throw new Error('--fecha-carga: fecha inválida');
    const hasta = flag('--hasta');
    const until = hasta === undefined ? undefined : STEP_ALIASES[hasta];
    if (hasta !== undefined && !until) {
      throw new Error(`--hasta: uno de ${Object.keys(STEP_ALIASES).join(', ')}`);
    }

    const sheets = readLoadSheets(buffer);
    // La revisión y lo que se sabe de los productos, en una transacción de solo lectura.
    const { review, productInfo } = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const ctx = await loadReviewContext(tx, sheets, {
          loadDate,
          historicalFloor: process.env.HISTORICAL_LOAD_START ?? DEFAULT_HISTORICAL_LOAD_START,
        });
        return { review: reviewBackdatedLoad(sheets, ctx), productInfo: ctx.productInfo };
      },
      { timeout: 10 * 60_000, maxWait: 30_000 },
    );
    const planned = planLoadOps(sheets, productInfo);
    const ops =
      until === undefined
        ? planned.ops
        : planned.ops.filter((o) => LOAD_STEPS.indexOf(o.step) <= LOAD_STEPS.indexOf(until));

    report.push(
      `# Carga atrasada · lote ${batchId} (${branch})`,
      '',
      `${execute ? 'EJECUCIÓN' : 'DRY-RUN'} · archivo ${file} · huella ${sha256.slice(0, 12)}${until ? ` · hasta ${LOAD_STEP_LABELS[until]}` : ''}`,
      '',
      ...stepTable(ops, manifest),
      ...lines(
        'Se cargan a mano (no se ejecutan)',
        planned.manual.map((m) => `${m.sheet} fila ${String(m.row)}: ${m.reason}`),
      ),
    );

    // La primera vez, la revisión es el candado: con un error no se escribe nada.
    const firstRun = manifest.start === null;
    if (firstRun && review.errors.length > 0) {
      report.push('## No se ejecuta: la revisión previa tiene errores', '', reviewMarkdown(review));
      failed = true;
      return;
    }
    if (firstRun)
      report.push(
        ...lines(
          'Avisos de la revisión',
          review.warnings.map(
            (w) => `${w.sheet}${w.row ? ` fila ${String(w.row)}` : ''}: ${w.message}`,
          ),
        ),
      );
    if (!execute) return;

    if (firstRun) await runner.start(file, sha256, planned.ops.length);
    const result = await runner.execute(ops, manifest);
    report.push(...resultLines(result));
    failed = result.failure !== null;
    const pending = await listPendingRecosts(prisma);
    if (pending.length > 0) {
      report.push(
        `**Quedaron ${String(pending.length)} recosteos pendientes:** corre \`pnpm recosteo:pendientes\` con la app sin usuarios.`,
        '',
      );
    }
  } finally {
    await app.close();
    if (report.length > 0) {
      const outDir = resolve(ROOT, 'local-data/carga-atrasada');
      mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
      const path = resolve(outDir, `${mode}-${branch}-${batchId}-${stamp}.md`);
      writeFileSync(path, `${report.join('\n')}\n`);
      console.error(report.join('\n'));
      console.error(`Informe en ${path}`);
    }
    if (failed) process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
