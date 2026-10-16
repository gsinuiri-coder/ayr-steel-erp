/**
 * cc56 (C2 de cc55, D-669) — **corregir el costo de la entrada de una bobina ya vendida**:
 * `pnpm fix:costo-bobina --bobina <código> --costo-kg <x> --motivo <PURCHASE_CORRECTION|…>
 *  --detalle "<texto>" --comprobante <número> --delta <S/>`.
 *
 * Usa `correctCoilEntryCost` (recosteo por fecha de la entrada, D-649/D-665). **Dry-run por defecto**:
 * corre dentro de una transacción que se revierte al final, mide Rentabilidad y Ventas y margen del
 * comprobante y de cada mes, y comprueba las condiciones del OK del dueño (`entryCostViolations`):
 * cambia solo esa entrada y su venta, en el monto esperado, cuadra al céntimo y no deja negativos.
 * `--execute` exige una vista previa válida de la misma rama y commit (< 24 h), vuelve a comprobar
 * todo dentro de la transacción y, si algo difiere, revierte.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Role, type Prisma } from '@prisma/client';
import {
  COST_CHANGE_REASONS,
  fromDateOnly,
  toDecimal,
  toFixedString,
  type CostChangeReason,
} from '@ayr/shared';
import { AppModule } from '../src/app.module';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import { AuditService } from '../src/audit/audit.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { shaWithChanges, DIRTY_SUFFIX } from '../src/inventory/recost-historic';
import { SalesMarginService } from '../src/reports/sales-margin.service';
import { SalesByMaterialService } from '../src/reports/sales-by-material.service';
import { DocumentProfitabilityService } from '../src/reports/document-profitability.service';
import { correctCoilEntryCost } from '../src/coils/coil-entry-cost';
import {
  entryCostViolations,
  type DocumentDelta,
  type EntryCostFacts,
} from '../src/coils/coil-entry-cost-checks';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set([
  '--bobina',
  '--costo-kg',
  '--motivo',
  '--detalle',
  '--comprobante',
  '--delta',
]);
const execute = args.includes('--execute');
const ROOT = resolve(__dirname, '../../../..');

function flag(name: string): string {
  const at = args.indexOf(name);
  const value = at === -1 ? undefined : args[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} es obligatorio`);
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

function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

interface Preview {
  branch: string;
  gitSha: string;
  generatedAtIso: string;
  executed: boolean;
  coil: string;
  unitCostPerKg: string;
  costReason: CostChangeReason;
  detail: string;
  expected: { document: string; deltaPen: string };
  fromPen: string;
  toPen: string;
  facts: EntryCostFacts;
  months: { month: string; costBefore: string; costAfter: string }[];
  violations: string[];
  issueDate: string;
  dispatchDates: string[];
}

class DryRun extends Error {
  constructor(readonly preview: Preview) {
    super('dry-run');
  }
}

/** Costo del comprobante en Rentabilidad y en Ventas y margen, y el costo de cada mes. */
async function measure(
  tx: Prisma.TransactionClient,
  documentId: string,
  months: string[],
): Promise<{ profitability: string; margin: string; months: Map<string, string> }> {
  const prisma = tx as unknown as PrismaService;
  const margin = new SalesMarginService(prisma);
  const profitability = new DocumentProfitabilityService(
    prisma,
    new SalesByMaterialService(prisma),
  );
  const p = await profitability.profitability(documentId);
  const byMonth = new Map<string, string>();
  let documentMargin = '0';
  for (const month of months) {
    const r = await margin.salesMargin({ from: `${month}-01`, to: monthEnd(month) });
    byMonth.set(month, r.totals.costPen);
    for (const o of r.orders) {
      for (const d of o.documents) if (d.id === documentId) documentMargin = d.costPen ?? '0';
    }
  }
  return { profitability: p.total.costPen, margin: documentMargin, months: byMonth };
}

async function main(): Promise<void> {
  assertArgs();
  assertExecuteAllowed(execute);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  const branch = process.env.AYR_CLI_BRANCH;
  if (!branch) throw new Error('Ejecutá este subcomando mediante runApiCli');
  const coilCode = flag('--bobina');
  const unitCostPerKg = toDecimal(flag('--costo-kg'));
  const costReason = flag('--motivo') as CostChangeReason;
  if (!COST_CHANGE_REASONS.includes(costReason)) {
    throw new Error(`--motivo tiene que ser uno de ${COST_CHANGE_REASONS.join(', ')}`);
  }
  const detail = flag('--detalle');
  const expected = { document: flag('--comprobante'), deltaPen: flag('--delta') };

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('Falta ADMIN_EMAIL');
  const lookup = new PrismaClient();
  const actor = await lookup.user.findUnique({ where: { email } });
  await lookup.$disconnect();
  if (!actor?.active || actor.role !== Role.ADMINISTRADOR) {
    throw new Error('ADMIN_EMAIL no es administrador activo');
  }

  const outDir = resolve(ROOT, 'local-data/cc56');
  mkdirSync(outDir, { recursive: true });
  const previewPath = resolve(outDir, `costo-bobina-VISTA-PREVIA-${branch}.json`);
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
    const same =
      previous.coil === coilCode &&
      previous.unitCostPerKg === unitCostPerKg.toFixed(4) &&
      previous.costReason === costReason &&
      previous.detail === detail &&
      previous.expected?.document === expected.document &&
      previous.expected.deltaPen === expected.deltaPen;
    if (!same) throw new Error('--execute rechazado: los argumentos no son los de la vista previa');
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
    const inventory = app.get(InventoryService);
    const audit = app.get(AuditService);
    try {
      preview = await db.$transaction(
        async (tx) => {
          const coil = await tx.coil.findUnique({ where: { code: coilCode } });
          if (!coil) throw new Error(`No existe la bobina ${coilCode}`);
          const doc = await tx.fiscalDocument.findFirst({
            where: {
              number: expected.document,
              archivedAt: null,
              docType: { in: ['FACTURA', 'BOLETA'] },
            },
            select: { id: true, issueDate: true },
          });
          if (!doc) throw new Error(`No existe el comprobante ${expected.document}`);
          const balance = () =>
            tx.inventoryBalance.findUnique({
              where: { itemType_itemId: { itemType: 'COIL', itemId: coil.id } },
              select: { qty: true, avgCost: true },
            });
          // Las cantidades del kardex las mueven las entradas y salidas; un ADJUST de recosteo lleva
          // la cantidad de la fila que corrige pero no cambia el saldo.
          const movementCount = () =>
            tx.inventoryMovement.count({
              where: { itemType: 'COIL', itemId: coil.id, type: { in: ['IN', 'OUT'] } },
            });
          const issueMonth = fromDateOnly(doc.issueDate).slice(0, 7);
          const sales = await tx.dispatch.findMany({
            where: { invoiceId: doc.id },
            select: { dispatchDate: true },
          });
          const months = [
            ...new Set([issueMonth, ...sales.map((s) => fromDateOnly(s.dispatchDate).slice(0, 7))]),
          ].sort();
          const issueDate = fromDateOnly(doc.issueDate);
          const dispatchDates = sales.map((s) => fromDateOnly(s.dispatchDate));

          const balanceBefore = await balance();
          const rowsBefore = await movementCount();
          const before = await measure(tx, doc.id, months);

          const result = await correctCoilEntryCost(tx, { inventory, audit }, actor.id, {
            coilId: coil.id,
            unitCostPerKg,
            costReason,
            detail,
          });

          const balanceAfter = await balance();
          const rowsAfter = await movementCount();
          const after = await measure(tx, doc.id, months);
          const adjusted = (result.outcome?.adjusted ?? []).map((a) => ({
            movementId: a.movement.id.toString(),
            itemId: a.item.itemId,
            type: a.movement.type,
            refType: a.movement.refType,
            operationDate: fromDateOnly(a.movement.operationDate),
            delta: a.delta.toFixed(4),
          }));
          // Los comprobantes cuyo costo cambió en Rentabilidad: el esperado y cualquier otro que
          // haya tocado una salida ajustada.
          const saleRefs = (result.outcome?.adjusted ?? []).flatMap((a) =>
            a.movement.refType === 'SALE' && a.movement.refId ? [a.movement.refId] : [],
          );
          const touchedDispatches = await tx.dispatch.findMany({
            where: { id: { in: saleRefs } },
            select: { invoice: { select: { id: true, number: true } } },
          });
          const touchedDocs = new Map(
            touchedDispatches.flatMap((d) =>
              d.invoice ? [[d.invoice.id, d.invoice.number ?? '']] : [],
            ),
          );
          const documents: DocumentDelta[] = [];
          for (const [id, number] of touchedDocs) {
            documents.push(
              id === doc.id
                ? {
                    number,
                    profitabilityBefore: before.profitability,
                    profitabilityAfter: after.profitability,
                    marginBefore: before.margin,
                    marginAfter: after.margin,
                  }
                : {
                    number,
                    profitabilityBefore: '0',
                    profitabilityAfter: '0',
                    marginBefore: '0',
                    marginAfter: '0',
                  },
            );
          }
          const value = (b: { qty: Prisma.Decimal; avgCost: Prisma.Decimal } | null) =>
            b
              ? toFixedString(toDecimal(b.qty.toString()).times(b.avgCost.toString()), 'MONEY')
              : '0.0000';
          const facts: EntryCostFacts = {
            coilId: coil.id,
            entryMovementId: result.entryMovementId,
            addPen: result.addPen,
            adjusted,
            documents,
            balanceQtyBefore: balanceBefore?.qty.toString() ?? '0',
            balanceQtyAfter: balanceAfter?.qty.toString() ?? '0',
            balanceValueBefore: value(balanceBefore),
            balanceValueAfter: value(balanceAfter),
            qtyChangingRows: rowsAfter - rowsBefore,
          };
          const p: Preview = {
            branch,
            gitSha: sha,
            generatedAtIso: new Date().toISOString(),
            executed: execute,
            coil: coilCode,
            unitCostPerKg: unitCostPerKg.toFixed(4),
            costReason,
            detail,
            expected,
            fromPen: result.fromPen,
            toPen: result.toPen,
            facts,
            months: months.map((m) => ({
              month: m,
              costBefore: before.months.get(m) ?? '0',
              costAfter: after.months.get(m) ?? '0',
            })),
            violations: entryCostViolations(facts, expected),
            issueDate,
            dispatchDates,
          };
          if (!execute) throw new DryRun(p);
          if (p.violations.length > 0) throw new DryRun({ ...p, executed: false });
          if (JSON.stringify(adjusted) !== JSON.stringify(previous?.facts.adjusted)) {
            throw new DryRun({
              ...p,
              executed: false,
              violations: ['los ajustes no coinciden con la vista previa'],
            });
          }
          return p;
        },
        { timeout: 600_000, maxWait: 30_000 },
      );
    } catch (err) {
      if (!(err instanceof DryRun)) throw err;
      preview = err.preview;
      if (execute) {
        writeFileSync(
          resolve(outDir, `costo-bobina-RECHAZADA-${branch}.json`),
          JSON.stringify(preview, null, 2),
        );
        throw new Error(`NO SE ESCRIBIÓ NADA en ${branch}: ${preview.violations.join(' · ')}`);
      }
    }
  } finally {
    await app.close();
  }
  const name = execute ? `costo-bobina-EJECUCION-${branch}` : `costo-bobina-VISTA-PREVIA-${branch}`;
  writeFileSync(resolve(outDir, `${name}.json`), JSON.stringify(preview, null, 2));
  if (execute) writeFileSync(previewPath, JSON.stringify({ ...previous, executed: true }, null, 2));
  console.error(JSON.stringify(preview, null, 2));
  console.error(
    preview.violations.length === 0
      ? `${execute ? 'EJECUTADO' : 'DRY-RUN'} en ${branch}: cumple todas las condiciones.`
      : `DRY-RUN en ${branch}: NO cumple: ${preview.violations.join(' · ')}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
