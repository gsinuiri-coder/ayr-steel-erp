/**
 * cc53 (D-652) — **qué ítems tienen hoy el kardex en negativo en alguna fecha.** Solo lectura: una
 * transacción `READ ONLY`, sin modo execute. Recorre cada ítem en el orden del kardex (fecha de
 * operación, registro, id) y anota los tramos en que el saldo en cantidad queda bajo cero. Imprime
 * un JSON en stdout (para `local-data/cc53/`, fuera del repo) y un resumen en stderr.
 *
 * cc54 (P3-2 de la revisión de cc53): cuenta como D-652 (`qtyRowsFromMovements` y
 * `negativeSpans` del motor): un par anulado el mismo día no abre un tramo.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { toDecimal } from '@ayr/shared';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import {
  negativeSpans,
  qtyRowsFromMovements,
  type QtyMovement,
} from '../src/inventory/recost-engine';

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
          select: {
            id: true,
            itemType: true,
            itemId: true,
            type: true,
            qty: true,
            operationDate: true,
            reversalOfId: true,
          },
        });
        const products = await tx.product.findMany({ select: { id: true, sku: true } });
        const coils = await tx.coil.findMany({ select: { id: true, code: true } });
        const label = new Map<string, string>([
          ...products.map((p) => [`PRODUCT:${p.id}`, p.sku] as const),
          ...coils.map((c) => [`COIL:${c.id}`, c.code] as const),
        ]);
        const byItem = new Map<string, QtyMovement[]>();
        for (const r of rows) {
          const k = `${r.itemType}:${r.itemId}`;
          const list = byItem.get(k) ?? [];
          list.push({
            id: r.id,
            reversalOfId: r.reversalOfId,
            date: r.operationDate.toISOString().slice(0, 10),
            type: r.type,
            qty: toDecimal(r.qty.toString()),
          });
          byItem.set(k, list);
        }
        const items = [...byItem].flatMap(([k, list]) => {
          const spans = negativeSpans(qtyRowsFromMovements(list));
          return spans.length > 0 ? [{ item: label.get(k) ?? k, spans }] : [];
        });
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
