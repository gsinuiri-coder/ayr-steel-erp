/**
 * cc57 (E-05 de audit-01) — **conciliación de `inventory_balances` contra el kardex.** Solo lectura:
 * una transacción `READ ONLY`, sin modo execute. Por cada saldo compara la cantidad y el valor
 * guardados (`qty × avg_cost`) contra el kardex reproducido por el motor (costos efectivos, el valor
 * se descarta al pasar por cero: la misma cuenta que `record`, D-649/D-653). Lista lo que difiere en
 * cantidad o en valor más de lo que explica el promedio a 4 decimales (ver `AVG_HALF_STEP`). Imprime un JSON en stdout (para `local-data/`, fuera del
 * repo) y un resumen en stderr. Pensado para correrlo al cerrar una ventana.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Decimal, toDecimal } from '@ayr/shared';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import { stockUpToDate } from '../src/inventory/inventory-recost';

/**
 * Lo que el promedio guardado a 4 decimales ya explica: `qty × 0,00005` (media diezmilésima por
 * unidad), y nunca menos de un céntimo (revisión del segundo modelo de cc57).
 */
const MIN_TOLERANCE_PEN = new Decimal('0.01');
const AVG_HALF_STEP = new Decimal('0.00005');
const KARDEX_END = new Date('9999-12-31T00:00:00.000Z');

async function main(): Promise<void> {
  if (process.argv.slice(2).length > 0) throw new Error('Uso: check:balances (sin argumentos)');
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
        const balances = await tx.inventoryBalance.findMany({
          select: { itemType: true, itemId: true, qty: true, avgCost: true },
          orderBy: [{ itemType: 'asc' }, { itemId: 'asc' }],
        });
        const products = await tx.product.findMany({ select: { id: true, sku: true } });
        const coils = await tx.coil.findMany({ select: { id: true, code: true } });
        const label = new Map<string, string>([
          ...products.map((p) => [`PRODUCT:${p.id}`, p.sku] as const),
          ...coils.map((c) => [`COIL:${c.id}`, c.code] as const),
        ]);
        let savedTotal = new Decimal(0);
        let kardexTotal = new Decimal(0);
        const items: {
          item: string;
          savedQty: string;
          kardexQty: string;
          savedValue: string;
          kardexValue: string;
          diffPen: string;
        }[] = [];
        for (const b of balances) {
          const kardex = await stockUpToDate(tx, b, KARDEX_END);
          const savedQty = toDecimal(b.qty.toString());
          const savedValue = savedQty.times(b.avgCost.toString());
          savedTotal = savedTotal.plus(savedValue);
          kardexTotal = kardexTotal.plus(kardex.value);
          const diff = savedValue.minus(kardex.value);
          const tolerance = Decimal.max(MIN_TOLERANCE_PEN, savedQty.abs().times(AVG_HALF_STEP));
          if (!savedQty.eq(kardex.qty) || diff.abs().gt(tolerance)) {
            items.push({
              item: label.get(`${b.itemType}:${b.itemId}`) ?? `${b.itemType}:${b.itemId}`,
              savedQty: savedQty.toFixed(3),
              kardexQty: kardex.qty.toFixed(3),
              savedValue: savedValue.toFixed(4),
              kardexValue: kardex.value.toFixed(4),
              diffPen: diff.toFixed(4),
            });
          }
        }
        return {
          balances: balances.length,
          differing: items.length,
          savedTotalPen: savedTotal.toFixed(4),
          kardexTotalPen: kardexTotal.toFixed(4),
          items,
        };
      },
      { timeout: 300_000 },
    );
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    console.error(
      `Saldos: ${String(report.balances)} · con diferencia: ${String(report.differing)} · ` +
        `valor guardado S/ ${report.savedTotalPen} · según el kardex S/ ${report.kardexTotalPen}`,
    );
    for (const i of report.items) {
      console.error(
        `  ${i.item}: cantidad ${i.savedQty} / ${i.kardexQty} · valor ${i.savedValue} / ${i.kardexValue} (${i.diffPen})`,
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
