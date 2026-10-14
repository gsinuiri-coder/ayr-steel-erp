/**
 * cc53 (D-652) — **qué ítems tienen hoy el kardex en negativo en alguna fecha.** Solo lectura: una
 * transacción `READ ONLY`, sin modo execute. Recorre cada ítem en el orden del kardex (fecha de
 * operación, registro, id) y anota los tramos en que el saldo en cantidad queda bajo cero. Imprime
 * un JSON en stdout (para `local-data/cc53/`, fuera del repo) y un resumen en stderr.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';

interface NegativeSpan {
  from: string;
  to: string | null;
  minQty: string;
}

async function main(): Promise<void> {
  if (process.argv.slice(2).length > 0) throw new Error('Uso: inspect:cc53 (sin argumentos)');
  assertExecuteAllowed(false);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  if (!process.env.AYR_CLI_BRANCH) throw new Error('Ejecutá este subcomando mediante runApiCli');
  const db = new PrismaClient();
  try {
    const report = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const rows = await tx.inventoryMovement.findMany({
          where: { type: { in: ['IN', 'OUT'] } },
          orderBy: [
            { itemType: 'asc' },
            { itemId: 'asc' },
            { operationDate: 'asc' },
            { at: 'asc' },
            { id: 'asc' },
          ],
          select: { itemType: true, itemId: true, type: true, qty: true, operationDate: true },
        });
        const products = await tx.product.findMany({ select: { id: true, sku: true } });
        const coils = await tx.coil.findMany({ select: { id: true, code: true } });
        const label = new Map<string, string>([
          ...products.map((p) => [`PRODUCT:${p.id}`, p.sku] as const),
          ...coils.map((c) => [`COIL:${c.id}`, c.code] as const),
        ]);
        const spans = new Map<string, NegativeSpan[]>();
        let key = '';
        let running = new Decimal(0);
        let open: NegativeSpan | null = null;
        const close = (date: string | null) => {
          if (!open) return;
          open.to = date;
          const list = spans.get(key) ?? [];
          list.push(open);
          spans.set(key, list);
          open = null;
        };
        for (const r of rows) {
          const k = `${r.itemType}:${r.itemId}`;
          const date = r.operationDate.toISOString().slice(0, 10);
          if (k !== key) {
            close(null);
            key = k;
            running = new Decimal(0);
          }
          const q = new Decimal(r.qty.toString());
          running = r.type === 'IN' ? running.plus(q) : running.minus(q);
          if (running.lt(0)) {
            if (!open) open = { from: date, to: null, minQty: running.toFixed(3) };
            else if (running.lt(open.minQty)) open.minQty = running.toFixed(3);
          } else if (open) {
            close(date);
          }
        }
        close(null);
        const items = [...spans].map(([k, list]) => ({ item: label.get(k) ?? k, spans: list }));
        return { itemsWithNegative: items.length, rows: rows.length, items };
      },
      { timeout: 120_000 },
    );
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    console.error(
      `Filas: ${String(report.rows)} · ítems con saldo negativo en alguna fecha: ${String(report.itemsWithNegative)}`,
    );
    for (const i of report.items) {
      console.error(
        `  ${i.item}: ${i.spans.map((s) => `${s.from}→${s.to ?? 'hoy'} (mín ${s.minQty})`).join('; ')}`,
      );
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
