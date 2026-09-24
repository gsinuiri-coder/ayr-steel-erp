/**
 * CLI del despacho a la fecha del comprobante (D-278) y del arreglo de estado de los pedidos
 * facturados sin despacho.
 *
 * Mismo patrón que el retiro de color (D-274): contexto de Nest y servicio de dominio
 * (`InvoiceDispatchService`), nunca SQL directo. **Dry-run por defecto**: lee todos los
 * comprobantes vivos con algo facturado sin despachar y muestra, por producto o bobina, la
 * fecha del saldo inicial, las fechas de los comprobantes, cuántas salidas se crean, cuántas
 * líneas caen en la excepción, las reservas liberadas y el saldo resultante. Guarda el plan en
 * `local-data/corr02/`.
 *
 * `--execute` vuelve a planificar y, si se pasa `--expect <plan.json>` (el del dry-run), para
 * sin escribir nada cuando el plan de ahora no coincide. Cada comprobante va en su propia
 * transacción, y cada uno vuelve a comparar su plan antes de escribir.
 *
 * Uso (vía `pnpm dispatch:at-issue-date`, que compila con `tsc -p tsconfig.cli.json`):
 *   pnpm dispatch:at-issue-date [--branch local|local-e2e|dev|demo|production]
 *   pnpm dispatch:at-issue-date --execute --expect <plan.json> --branch production --confirm-production
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
import { PrismaService } from '../src/prisma/prisma.service';
import {
  InvoiceDispatchService,
  planSignature,
  type InvoiceDispatchPlan,
} from '../src/invoicing/invoice-dispatch.service';
import type { RequestUser } from '../src/auth/auth.types';

const execute = process.argv.includes('--execute');
const expectFlag = process.argv.indexOf('--expect');
const expectPath = expectFlag === -1 ? undefined : process.argv[expectFlag + 1];

interface ItemReport {
  item: string;
  unit: string;
  openingDate: string | null;
  invoiceDates: string[];
  outs: number;
  outQty: string;
  outCostPen: string;
  exceptions: number;
  exceptionQty: string;
  reservationsReleased: string;
  balanceNow: string;
  balanceAfter: string;
  review: string[];
}

function report(plan: InvoiceDispatchPlan): {
  items: ItemReport[];
  review: string[];
  totals: Record<string, string | number>;
  signatures: Record<string, string>;
} {
  const byItem = new Map<string, ItemReport>();
  const review: string[] = [];
  let outCost = new Decimal(0);
  let outs = 0;
  let exceptions = 0;
  const signatures: Record<string, string> = {};
  for (const inv of plan.invoices) {
    signatures[inv.number] = planSignature(inv);
    for (const l of inv.lines) {
      const info = l.itemKey === null ? undefined : plan.items.get(l.itemKey);
      if (l.action === 'REVIEW') {
        review.push(
          `${inv.orderCode} · ${inv.number} (${inv.issueDate}) · línea ${String(l.lineNumber)} ${l.sku} ${l.qty.toFixed(3)}: ${l.reason ?? ''}`,
        );
      }
      if (info === undefined) continue;
      const r = byItem.get(info.key) ?? {
        item: info.label,
        unit: info.unit,
        openingDate: info.openingDate,
        invoiceDates: [],
        outs: 0,
        outQty: '0',
        outCostPen: '0',
        exceptions: 0,
        exceptionQty: '0',
        reservationsReleased: '0',
        balanceNow: info.balanceQty.toFixed(3),
        balanceAfter: info.balanceQty.toFixed(3),
        review: [],
      };
      if (!r.invoiceDates.includes(inv.issueDate)) r.invoiceDates.push(inv.issueDate);
      if (l.action === 'DISPATCH') {
        const cost = l.reserveQty.times(info.avgCost);
        outCost = outCost.plus(cost);
        outs += 1;
        r.outs += 1;
        r.outQty = new Decimal(r.outQty).plus(l.reserveQty).toFixed(3);
        r.outCostPen = new Decimal(r.outCostPen).plus(cost).toFixed(4);
        r.balanceAfter = new Decimal(r.balanceAfter).minus(l.reserveQty).toFixed(3);
        r.reservationsReleased = new Decimal(r.reservationsReleased).plus(l.reserveQty).toFixed(3);
      } else if (l.action === 'BEFORE_OPENING') {
        exceptions += 1;
        r.exceptions += 1;
        r.exceptionQty = new Decimal(r.exceptionQty).plus(l.reserveQty).toFixed(3);
        r.reservationsReleased = new Decimal(r.reservationsReleased).plus(l.reserveQty).toFixed(3);
      } else {
        r.review.push(`${inv.number} línea ${String(l.lineNumber)}`);
      }
      byItem.set(info.key, r);
    }
  }
  for (const r of byItem.values()) r.invoiceDates.sort();
  return {
    items: [...byItem.values()].sort((a, b) => a.item.localeCompare(b.item)),
    review,
    totals: {
      invoices: plan.invoices.length,
      outs,
      exceptions,
      reviewLines: review.length,
      outCostPen: outCost.toFixed(4),
    },
    signatures,
  };
}

function print(r: ReturnType<typeof report>): void {
  for (const it of r.items) {
    console.warn(
      `\n${it.item} (${it.unit}) · saldo inicial: ${it.openingDate ?? 'sin carga inicial'} · comprobantes: ${it.invoiceDates.join(', ')}`,
    );
    console.warn(
      `  salidas: ${String(it.outs)} (${it.outQty}, S/ ${it.outCostPen}) · excepción: ${String(it.exceptions)} (${it.exceptionQty}) · reservas liberadas: ${it.reservationsReleased} · saldo ${it.balanceNow} → ${it.balanceAfter}` +
        (it.review.length > 0 ? ` · a revisión: ${it.review.join(', ')}` : ''),
    );
  }
  console.warn(`\nA revisión (${String(r.review.length)}):`);
  for (const line of r.review) console.warn(`  - ${line}`);
  console.warn(`\nTotales: ${JSON.stringify(r.totals)}`);
}

async function main(): Promise<void> {
  assertExecuteAllowed(execute);
  const branch = process.env.AYR_CLI_BRANCH ?? '(sin declarar)';
  console.error(`Destino: ${branch}`);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  if (execute && expectPath === undefined && branch === 'production') {
    throw new Error('Contra production, --execute exige --expect <plan.json> del dry-run');
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
    const service = app.get(InvoiceDispatchService);
    const plan = await service.planAll();
    const r = report(plan);
    print(r);
    const dir = resolve(__dirname, '../../../../local-data/corr02');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = resolve(dir, `dispatch-at-issue-date-${branch}-${stamp}.json`);
    writeFileSync(file, JSON.stringify(r, null, 1));
    console.warn(`\nPlan guardado en ${file}`);
    if (!execute) {
      console.warn('Dry-run: no se escribió nada.');
      return;
    }

    if (expectPath !== undefined) {
      const expected = JSON.parse(readFileSync(resolve(expectPath), 'utf8')) as {
        signatures: Record<string, string>;
      };
      const now = JSON.stringify(r.signatures);
      const before = JSON.stringify(expected.signatures);
      if (now !== before) {
        throw new Error(
          'El plan de ahora no coincide con el del dry-run: no se escribe nada. Compará los dos JSON.',
        );
      }
      console.warn('El plan coincide con el del dry-run.');
    }

    const prismaService = app.get(PrismaService);
    let done = 0;
    for (const inv of plan.invoices) {
      if (!inv.lines.some((l) => l.action !== 'REVIEW')) continue;
      const result = await prismaService.$transaction(
        (tx) => service.executeInTx(tx, actor, inv.invoiceId, inv),
        { timeout: 120_000 },
      );
      done += 1;
      console.warn(
        `  ${inv.orderCode} · ${inv.number}: ${String(result.dispatchIds.length)} despacho(s), pedido ${result.orderStatus}`,
      );
    }
    console.warn(`\nListo: ${String(done)} comprobante(s) procesado(s), con auditoría.`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
