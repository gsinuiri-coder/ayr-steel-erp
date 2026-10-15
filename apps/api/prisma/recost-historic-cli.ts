/**
 * cc53 (D-651) — **corrección única del recosteo por fecha** de los SKU afectados (cc52):
 * `pnpm recosteo:historico`. Aplica el mismo motor del recosteo en línea (`InventoryService
 * .recostForward`, D-649) sobre la historia completa de cada SKU y lo que arrastre la cadena.
 *
 * **Dry-run por defecto**: todo corre dentro de una transacción que se revierte al final; mide los
 * reportes antes y después **dentro** de ella (Ventas y margen, rentabilidad de cada comprobante
 * afectado, inventario valorizado) y deja la vista previa en `local-data/cc53/` (fuera del repo).
 * `--execute` contra production exige además `--confirm-production` (lo pide el wrapper) y el OK
 * del dueño por nombre.
 *
 * cc54 (P2-6 de la revisión de cc53; D-653): `--execute` **se niega** a correr sin una vista previa
 * de la misma rama, del mismo commit y de menos de `PREVIEW_MAX_AGE_HOURS`; y compara al céntimo
 * **dentro** de la transacción, antes del commit: si difiere, revierte y no escribe nada.
 * P2-7: la transacción bloquea los SKU del alcance hasta 10 min (ventas y despachos esperan):
 * se corre en horario muerto.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Role, type Prisma } from '@prisma/client';
import { businessToday, Decimal, fromDateOnly, toFixedString } from '@ayr/shared';
import { AppModule } from '../src/app.module';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import { PrismaService } from '../src/prisma/prisma.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { planRecost, type RecostSeed } from '../src/inventory/inventory-recost';
import {
  comparePreviews,
  DIRTY_SUFFIX,
  monthlyDeltas,
  previewRejection,
  renderHistoricPreview,
  type BeforeAfter,
  type DocumentBeforeAfter,
  type HistoricPreview,
} from '../src/inventory/recost-historic';
import { SalesMarginService } from '../src/reports/sales-margin.service';
import { SalesByMaterialService } from '../src/reports/sales-by-material.service';
import { DocumentProfitabilityService } from '../src/reports/document-profitability.service';

/** Los SKU del informe de cc52 (diferencias reales); los demás solo difieren por redondeo. */
const DEFAULT_SKUS = ['UPVC6MT', 'UPVC36MT', 'COB030ROJO', 'PL040RJ6MT'];
const LABEL = 'Recosteo histórico cc53';
/** Los meses del informe al dueño, más los de cada comprobante afectado. */
const BASE_MONTHS = ['2026-09', '2026-10'];

const args = process.argv.slice(2);
const execute = args.includes('--execute');

function parseSkus(): string[] {
  const at = args.indexOf('--sku');
  if (at === -1) return DEFAULT_SKUS;
  const value = args[at + 1];
  if (!value || value.startsWith('--'))
    throw new Error('--sku requiere una lista separada por comas');
  const skus = value.split(',').map((s) => s.trim());
  if (skus.some((s) => !/^[A-Z0-9-]{1,40}$/i.test(s))) throw new Error('--sku: SKU inválido');
  return skus;
}

function assertArgs(): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--execute') continue;
    if (arg === '--sku') {
      i += 1;
      continue;
    }
    throw new Error(`Argumento no reconocido: ${arg ?? ''}`);
  }
}

/** El fin de un mes `YYYY-MM`. */
function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

class DryRun extends Error {
  constructor(readonly preview: HistoricPreview) {
    super('dry-run');
  }
}

/** cc54 (P2-6): la ejecución no coincide con la vista previa; se lanza para revertir. */
class Mismatch extends Error {
  constructor(
    readonly preview: HistoricPreview,
    readonly differences: string[],
  ) {
    super('mismatch');
  }
}

/**
 * El commit del checkout (lo que se compara entre el dry-run y la ejecución), con `DIRTY_SUFFIX`
 * si `apps` o `packages` tienen cambios sin commitear (entonces `--execute` se niega).
 */
function gitSha(): string {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'apps', 'packages'], {
    encoding: 'utf8',
    cwd: resolve(__dirname, '../../..'),
  }).trim();
  return dirty === '' ? head : `${head}${DIRTY_SUFFIX}`;
}

function readPreview(path: string): HistoricPreview | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as HistoricPreview) : null;
}

interface Scope {
  items: { id: string; sku: string }[];
  documents: { id: string; number: string; issueDate: string }[];
  months: string[];
}

interface Snapshot {
  margin: Map<string, { cost: string; margin: string }>;
  documents: Map<string, { sales: string; cost: string; profit: string; margin: string | null }>;
  inventory: Map<string, string>;
}

async function snapshot(tx: Prisma.TransactionClient, scope: Scope): Promise<Snapshot> {
  const prisma = tx as unknown as PrismaService;
  const marginService = new SalesMarginService(prisma);
  const profitability = new DocumentProfitabilityService(
    prisma,
    new SalesByMaterialService(prisma),
  );
  const margin = new Map<string, { cost: string; margin: string }>();
  for (const month of scope.months) {
    const r = await marginService.salesMargin({ from: `${month}-01`, to: monthEnd(month) });
    margin.set(month, { cost: r.totals.costPen, margin: r.totals.marginPen });
  }
  const documents = new Map<
    string,
    { sales: string; cost: string; profit: string; margin: string | null }
  >();
  for (const d of scope.documents) {
    const p = await profitability.profitability(d.id);
    documents.set(d.id, {
      sales: p.total.salesPen,
      cost: p.total.costPen,
      profit: p.total.profitPen,
      margin: p.total.marginPct,
    });
  }
  const balances = await tx.inventoryBalance.findMany({
    where: { itemType: 'PRODUCT', itemId: { in: scope.items.map((i) => i.id) } },
    select: { itemId: true, qty: true, avgCost: true },
  });
  const inventory = new Map(
    balances.map((b) => [
      b.itemId,
      toFixedString(new Decimal(b.qty.toString()).times(b.avgCost.toString()), 'MONEY'),
    ]),
  );
  return { margin, documents, inventory };
}

async function main(): Promise<void> {
  assertArgs();
  const skus = parseSkus();
  assertExecuteAllowed(execute);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  const branch = process.env.AYR_CLI_BRANCH;
  if (!branch) throw new Error('Ejecutá este subcomando mediante runApiCli');
  const actorEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!actorEmail) throw new Error('Falta ADMIN_EMAIL');
  const lookup = new PrismaClient();
  const actor = await lookup.user.findUnique({ where: { email: actorEmail } });
  await lookup.$disconnect();
  if (!actor?.active || actor.role !== Role.ADMINISTRADOR)
    throw new Error('ADMIN_EMAIL no es administrador activo');

  const outDir = resolve(__dirname, '../../../../local-data/cc53');
  mkdirSync(outDir, { recursive: true });
  const previewJson = resolve(outDir, `VISTA-PREVIA-${branch}.json`);
  const sha = gitSha();
  // cc54 (P2-6): sin vista previa válida no se abre la transacción.
  const expected = execute ? readPreview(previewJson) : null;
  if (execute) {
    const rejection = previewRejection(expected, { branch, gitSha: sha, at: new Date() });
    if (rejection !== null) throw new Error(`--execute rechazado: ${rejection}`);
    console.error(
      `Aviso: la corrida bloquea ventas y despachos de ${skus.join(', ')} y lo que arrastre la ` +
        'cadena hasta que termine (tope 10 min). Córrela en horario muerto.',
    );
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  let preview: HistoricPreview;
  try {
    const db = app.get(PrismaService);
    const inventory = app.get(InventoryService);
    try {
      preview = await db.$transaction(
        async (tx) => {
          const products = await tx.product.findMany({
            where: { sku: { in: skus } },
            select: { id: true, sku: true },
          });
          const missing = skus.filter((s) => !products.some((p) => p.sku === s));
          if (missing.length > 0) throw new Error(`SKU sin producto: ${missing.join(', ')}`);
          const seeds: RecostSeed[] = products.map((p) => ({
            itemType: 'PRODUCT',
            itemId: p.id,
            fromStart: true,
          }));

          // El alcance, antes de escribir: lo que el recosteo va a tocar.
          const plan = await planRecost(tx, seeds, Number.MAX_SAFE_INTEGER);
          const adjusts = plan.items.flatMap((i) => i.adjusts);
          const dispatchIds = [
            ...new Set(
              adjusts.flatMap((a) =>
                a.movement.refType === 'SALE' && a.movement.refId ? [a.movement.refId] : [],
              ),
            ),
          ];
          const dispatches = await tx.dispatch.findMany({
            where: { id: { in: dispatchIds }, invoiceId: { not: null } },
            select: {
              invoice: { select: { id: true, number: true, issueDate: true } },
            },
          });
          const docs = new Map(
            dispatches.flatMap((d) =>
              d.invoice
                ? [
                    [
                      d.invoice.id,
                      {
                        id: d.invoice.id,
                        number: d.invoice.number ?? '(sin número)',
                        issueDate: fromDateOnly(d.invoice.issueDate),
                      },
                    ] as const,
                  ]
                : [],
            ),
          );
          const documents = [...docs.values()].sort((a, b) =>
            a.issueDate.localeCompare(b.issueDate),
          );
          const months = [
            ...new Set([...BASE_MONTHS, ...documents.map((d) => d.issueDate.slice(0, 7))]),
          ].sort();
          const itemIds = new Set(plan.items.map((i) => i.item.itemId));
          const allProducts = await tx.product.findMany({
            where: { id: { in: [...itemIds] } },
            select: { id: true, sku: true },
          });
          const coils = await tx.coil.findMany({
            where: { id: { in: [...itemIds] } },
            select: { id: true, code: true },
          });
          const label = new Map<string, string>([
            ...allProducts.map((p) => [p.id, p.sku] as const),
            ...coils.map((c) => [c.id, c.code] as const),
          ]);
          const scope: Scope = { items: allProducts, documents, months };

          const before = await snapshot(tx, scope);
          const outcome = await inventory.recostForward(tx, seeds, {
            actorId: actor.id,
            historic: { label: LABEL },
          });
          const after = await snapshot(tx, scope);
          const residual = (await planRecost(tx, seeds, Number.MAX_SAFE_INTEGER)).items.flatMap(
            (i) => i.adjusts,
          ).length;

          const salesMargin: BeforeAfter[] = months.flatMap((m) => [
            {
              label: `${m} costo`,
              before: before.margin.get(m)?.cost ?? '0',
              after: after.margin.get(m)?.cost ?? '0',
            },
            {
              label: `${m} margen`,
              before: before.margin.get(m)?.margin ?? '0',
              after: after.margin.get(m)?.margin ?? '0',
            },
          ]);
          const docRows: DocumentBeforeAfter[] = documents.map((d) => {
            const b = before.documents.get(d.id);
            const a = after.documents.get(d.id);
            return {
              number: d.number,
              issueDate: d.issueDate,
              salesPen: a?.sales ?? '0',
              costBefore: b?.cost ?? '0',
              costAfter: a?.cost ?? '0',
              profitBefore: b?.profit ?? '0',
              profitAfter: a?.profit ?? '0',
              marginBefore: b?.margin ?? null,
              marginAfter: a?.margin ?? null,
            };
          });
          const inventoryRows: BeforeAfter[] = allProducts.map((p) => ({
            label: p.sku,
            before: before.inventory.get(p.id) ?? '0',
            after: after.inventory.get(p.id) ?? '0',
          }));
          const result: HistoricPreview = {
            branch,
            generatedAt: `${businessToday()} (Lima)`,
            gitSha: sha,
            generatedAtIso: new Date().toISOString(),
            skus,
            adjustments: outcome.adjusted.length,
            rowsReplayed: outcome.rowsReplayed,
            months: monthlyDeltas(
              outcome.adjusted.map((a) => ({
                item: label.get(a.movement.itemId) ?? a.movement.itemId,
                operationDate: fromDateOnly(a.movement.operationDate),
                type: a.movement.type,
                refType: a.movement.refType,
                delta: a.delta,
              })),
            ),
            documents: docRows,
            salesMargin,
            inventory: inventoryRows,
            residual,
          };
          if (!execute) throw new DryRun(result);
          // cc54 (P2-6): el candado es antes del commit; una diferencia revierte todo.
          const differences =
            expected === null ? ['sin vista previa'] : comparePreviews(expected, result);
          if (differences.length > 0) throw new Mismatch(result, differences);
          return result;
        },
        { timeout: 600_000, maxWait: 30_000 },
      );
    } catch (err) {
      if (err instanceof Mismatch) {
        writeFileSync(
          resolve(outDir, `RECHAZADA-${branch}.json`),
          JSON.stringify(err.preview, null, 2),
        );
        throw new Error(
          `NO SE ESCRIBIÓ NADA en ${branch}: la ejecución no coincide con la vista previa ` +
            `(la transacción se revirtió).\n${err.differences.join('\n')}`,
        );
      }
      if (!(err instanceof DryRun)) throw err;
      preview = err.preview;
    }
  } finally {
    await app.close();
  }

  const name = execute ? `EJECUCION-${branch}` : `VISTA-PREVIA-${branch}`;
  writeFileSync(resolve(outDir, `${name}.json`), JSON.stringify(preview, null, 2));
  writeFileSync(resolve(outDir, `${name}.md`), renderHistoricPreview(preview));
  console.error(renderHistoricPreview(preview));
  console.error(
    execute
      ? `EJECUTADO en ${branch}: ${String(preview.adjustments)} ajuste(s) «${LABEL}».`
      : `DRY-RUN en ${branch}: nada se escribió (la transacción se revirtió).`,
  );
  if (execute) console.error('Coincide con la vista previa del dry-run, al céntimo.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
