/**
 * CLI de D-285: fecha efectiva del inventario inicial y lo que destraba (salidas de lo
 * despachado sin ellas y despacho de lo facturado).
 *
 * Contexto de Nest y servicios de dominio, nunca SQL directo. **Dry-run por defecto** en una
 * transacción `READ ONLY`: por ítem, la fecha de la carga inicial antes → después; las salidas
 * a crear con su fecha y costo; las líneas que siguen a revisión; el costo total. Guarda el plan
 * en `local-data/corr02/`. `--execute --expect <plan.json>` vuelve a planificar y para sin
 * escribir si la huella no es la del dry-run. La excepción del kardex no se puede repetir.
 *
 * Uso (vía `pnpm inventory:opening-date`, que compila con `tsc -p tsconfig.cli.json`):
 *   pnpm inventory:opening-date [--branch local|local-e2e|dev|demo|production]
 *   pnpm inventory:opening-date --execute --expect <plan.json> --branch production --confirm-production
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Role } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import { AppModule } from '../src/app.module';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import {
  OpeningDateMoveService,
  openingPlanSignature,
  type OpeningDateMovePlan,
} from '../src/invoicing/opening-date-move.service';
import type { RequestUser } from '../src/auth/auth.types';

const execute = process.argv.includes('--execute');
const expectFlag = process.argv.indexOf('--expect');
const expectPath = expectFlag === -1 ? undefined : process.argv[expectFlag + 1];

function summarize(plan: OpeningDateMovePlan) {
  const sales: {
    kind: string;
    order: string;
    doc: string;
    sku: string;
    item: string;
    date: string;
    qty: string;
    costPen: string;
  }[] = [];
  const review: string[] = [];
  let total = new Decimal(0);
  for (const a of plan.added) {
    if (a.action === 'ADD') {
      total = total.plus(a.costPen);
      sales.push({
        kind: 'salida agregada',
        order: a.orderCode,
        doc: a.dispatchCode,
        sku: a.sku,
        item: a.label,
        date: a.date,
        qty: a.qty.toFixed(3),
        costPen: a.costPen.toFixed(4),
      });
    } else {
      review.push(`${a.orderCode} · ${a.dispatchCode} · ${a.sku}: ${a.reason ?? ''}`);
    }
  }
  for (const inv of plan.dispatch.invoices) {
    for (const l of inv.lines) {
      if (l.action === 'REVIEW' || l.itemKey === null) {
        review.push(
          `${inv.orderCode} · ${inv.number} · línea ${String(l.lineNumber)} ${l.sku}: ${l.reason ?? ''}`,
        );
        continue;
      }
      const cost =
        l.action === 'DISPATCH'
          ? l.reserveQty.times(plan.avgCost.get(l.itemKey) ?? 0)
          : new Decimal(0);
      total = total.plus(cost);
      sales.push({
        kind: l.action === 'DISPATCH' ? 'despacho nuevo' : 'entregado sin salida',
        order: inv.orderCode,
        doc: inv.number,
        sku: l.sku,
        item: plan.dispatch.items.get(l.itemKey)?.label ?? l.itemKey,
        date: l.operationDate,
        qty: l.reserveQty.toFixed(3),
        costPen: cost.toFixed(4),
      });
    }
  }
  const byItem = new Map<string, { count: number; qty: Decimal; cost: Decimal }>();
  for (const s of sales) {
    const e = byItem.get(s.item) ?? { count: 0, qty: new Decimal(0), cost: new Decimal(0) };
    byItem.set(s.item, {
      count: e.count + 1,
      qty: e.qty.plus(s.qty),
      cost: e.cost.plus(s.costPen),
    });
  }
  return {
    target: plan.target,
    moves: plan.moves.map((m) => ({
      item: m.label,
      action: m.action,
      from: [...new Set(m.from)].join(','),
      to: m.to,
      movements: m.movementIds.length,
      reason: m.reason,
    })),
    sales,
    byItem: [...byItem].map(([item, v]) => ({
      item,
      sales: v.count,
      qty: v.qty.toFixed(3),
      costPen: v.cost.toFixed(4),
    })),
    review,
    totals: {
      itemsMoved: plan.moves.filter((m) => m.action === 'MOVE').length,
      itemsSkipped: plan.moves.filter((m) => m.action === 'SKIP').length,
      movementsMoved: plan.moves
        .filter((m) => m.action === 'MOVE')
        .reduce((n, m) => n + m.movementIds.length, 0),
      newSales: sales.filter((s) => s.kind !== 'entregado sin salida').length,
      withoutSale: sales.filter((s) => s.kind === 'entregado sin salida').length,
      reviewLines: review.length,
      costPen: total.toFixed(4),
    },
    signature: openingPlanSignature(plan),
  };
}

function print(s: ReturnType<typeof summarize>): void {
  console.warn(`Fecha efectiva del inventario inicial: ${s.target}`);
  for (const m of s.moves) {
    console.warn(
      `  ${m.item}: ${m.action} ${m.from} → ${m.to} (${String(m.movements)} mov.)${m.reason ? ` — ${m.reason}` : ''}`,
    );
  }
  console.warn('\nSalidas por ítem:');
  for (const b of s.byItem) {
    console.warn(`  ${b.item}: ${String(b.sales)} salida(s), ${b.qty}, S/ ${b.costPen}`);
  }
  console.warn('\nSalidas, una por una:');
  for (const x of s.sales) {
    console.warn(
      `  ${x.date} ${x.kind} · ${x.order} · ${x.doc} · ${x.sku} (${x.item}) ${x.qty} · S/ ${x.costPen}`,
    );
  }
  console.warn(`\nA revisión (${String(s.review.length)}):`);
  for (const r of s.review) console.warn(`  - ${r}`);
  console.warn(`\nTotales: ${JSON.stringify(s.totals)}`);
}

async function main(): Promise<void> {
  assertExecuteAllowed(execute);
  const branch = process.env.AYR_CLI_BRANCH ?? '(sin declarar)';
  console.error(`Destino: ${branch}`);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  if (execute && expectPath === undefined) {
    throw new Error('--execute exige --expect <plan.json> del dry-run');
  }

  const prisma = new PrismaClient();
  const actorEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!actorEmail) throw new Error('Falta ADMIN_EMAIL en el entorno');
  const actorUser = await prisma.user.findUnique({ where: { email: actorEmail } });
  await prisma.$disconnect();
  if (!actorUser || !actorUser.active || actorUser.role !== Role.ADMINISTRADOR) {
    throw new Error(`${actorEmail} no es un ADMINISTRADOR activo en esta rama`);
  }
  const actor: RequestUser = {
    id: actorUser.id,
    email: actorUser.email,
    name: actorUser.name,
    role: actorUser.role,
    mustChangePassword: false,
    sessionId: 'cli',
  };

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const service = app.get(OpeningDateMoveService);
    if (!execute) {
      const s = summarize(await service.plan());
      print(s);
      const dir = resolve(__dirname, '../../../../local-data/corr02');
      mkdirSync(dir, { recursive: true });
      const file = resolve(
        dir,
        `opening-date-${branch}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      );
      writeFileSync(file, JSON.stringify(s, null, 1));
      console.warn(`\nPlan guardado en ${file}\nDry-run: no se escribió nada.`);
      return;
    }
    const expected = JSON.parse(readFileSync(resolve(expectPath ?? ''), 'utf8')) as {
      signature: string;
    };
    console.warn('Ejecutando…');
    const done = summarize(await service.execute(actor, expected.signature));
    console.warn(`Listo, con auditoría. Totales: ${JSON.stringify(done.totals)}`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
