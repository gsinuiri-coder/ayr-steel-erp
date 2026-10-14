/**
 * cc52 — diagnóstico del kardex en sus dos vistas: Promedio (el saldo corrido de
 * `InventoryService.findMovements`) y PEPS (`valuePeps`, el reporte de SUNAT, D-279).
 * **Solo lectura**: una transacción `READ ONLY`, sin modo execute y sin reparar nada. Imprime un
 * JSON en stdout (para guardarlo en `local-data/cc52/`, que no se sube al repo) y un resumen en
 * stderr.
 *
 * De cada ítem con movimientos compara, fila por fila, la cantidad del saldo que muestran las dos
 * vistas y el saldo final contra `inventory_balances`. Del SKU pedido (`--sku`, por defecto
 * UPVC6MT) vuelca además las filas de las dos vistas con su valor, para explicar la diferencia.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Decimal, toDecimal, toFixedString } from '@ayr/shared';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import { valuePeps, type PepsMovement } from '../src/reports/kardex-peps';

const ZERO = new Decimal(0);

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseSku(args: string[]): string {
  if (args.length === 0) return 'UPVC6MT';
  if (args.length === 2 && args[0] === '--sku' && /^[A-Z0-9-]{1,40}$/i.test(args[1] ?? '')) {
    return args[1] as string;
  }
  throw new Error('Uso: inspect:cc52 [--sku <SKU>] (solo lectura)');
}

interface Mv {
  id: bigint;
  itemType: string;
  itemId: string;
  type: 'IN' | 'OUT' | 'ADJUST';
  qty: { toString(): string };
  unitCost: { toString(): string };
  totalCost: { toString(): string };
  refType: string;
  reversalOfId: bigint | null;
  operationDate: Date;
  at: Date;
}

/** El saldo corrido de la vista Promedio, con la misma cuenta que `findMovements`. */
function averageRows(movements: Mv[]) {
  let qty = ZERO;
  let value = ZERO;
  return movements.map((m) => {
    const q = toDecimal(m.qty.toString());
    const total = toDecimal(m.totalCost.toString());
    if (m.type === 'IN') {
      qty = qty.plus(q);
      value = value.plus(total);
    } else if (m.type === 'OUT') {
      qty = qty.minus(q);
      value = value.minus(total);
    } else {
      value = value.plus(total);
    }
    if (value.isNegative()) value = ZERO;
    return {
      id: m.id.toString(),
      balanceQty: qty.toFixed(3),
      balanceValue: toFixedString(value, 'MONEY'),
      avg: toFixedString(qty.lte(0) ? ZERO : value.div(qty), 'MONEY'),
    };
  });
}

/**
 * El promedio recalculado **en orden de fecha**: cada salida toma el promedio que el ítem tenía
 * a su fecha, la anulación de una salida devuelve ese mismo costo y la de una entrada saca el
 * costo de la entrada. Es lo que el kardex habría registrado si todo se hubiera grabado a tiempo
 * (la pieza de recosteo, cc53). Devuelve la diferencia de costo de venta por mes (recalculado −
 * registrado) y el valor final recalculado.
 */
function recost(movements: Mv[]) {
  let qty = ZERO;
  let value = ZERO;
  const corrected = new Map<string, Decimal>();
  const byMonth = new Map<string, Decimal>();
  let changed = 0;
  for (const m of movements) {
    const q = toDecimal(m.qty.toString());
    const recorded = toDecimal(m.totalCost.toString());
    const month = dateOnly(m.operationDate).slice(0, 7);
    let cost = recorded;
    if (m.type === 'IN') {
      if (m.reversalOfId !== null) cost = corrected.get(m.reversalOfId.toString()) ?? recorded;
      qty = qty.plus(q);
      value = value.plus(cost);
      if (m.reversalOfId !== null) {
        // La anulación de una salida resta del costo de venta lo que la salida sumó.
        const diff = cost.minus(recorded).negated();
        if (!diff.isZero()) byMonth.set(month, (byMonth.get(month) ?? ZERO).plus(diff));
      }
    } else if (m.type === 'OUT') {
      if (m.reversalOfId === null && qty.gt(0)) {
        cost = q.times(value.div(qty)).toDecimalPlaces(4);
      }
      corrected.set(m.id.toString(), cost);
      qty = qty.minus(q);
      value = value.minus(cost);
      if (m.reversalOfId === null) {
        const diff = cost.minus(recorded);
        if (diff.abs().gte('0.005')) {
          changed += 1;
          byMonth.set(month, (byMonth.get(month) ?? ZERO).plus(diff));
        }
      }
    } else {
      value = value.plus(recorded);
    }
    if (value.isNegative()) value = ZERO;
  }
  return { byMonth, closingValue: value, closingQty: qty, changed };
}

function toPeps(m: Mv): PepsMovement {
  return {
    id: m.id.toString(),
    type: m.type,
    qty: m.qty.toString(),
    totalCost: m.totalCost.toString(),
    operationDate: dateOnly(m.operationDate),
    reversalOfId: m.reversalOfId === null ? null : m.reversalOfId.toString(),
  };
}

async function main(): Promise<void> {
  const sku = parseSku(process.argv.slice(2));
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
        const all = (await tx.inventoryMovement.findMany({
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
            unitCost: true,
            totalCost: true,
            refType: true,
            reversalOfId: true,
            operationDate: true,
            at: true,
          },
        })) as Mv[];
        const balances = await tx.inventoryBalance.findMany({
          select: { itemType: true, itemId: true, qty: true, avgCost: true },
        });
        const balanceOf = new Map(balances.map((b) => [`${b.itemType}:${b.itemId}`, b]));
        const byItem = new Map<string, Mv[]>();
        for (const m of all) {
          const key = `${m.itemType}:${m.itemId}`;
          const list = byItem.get(key) ?? [];
          list.push(m);
          byItem.set(key, list);
        }
        const products = await tx.product.findMany({ select: { id: true, sku: true } });
        const coils = await tx.coil.findMany({ select: { id: true, code: true } });
        const label = new Map<string, string>([
          ...products.map((p) => [`PRODUCT:${p.id}`, p.sku] as const),
          ...coils.map((c) => [`COIL:${c.id}`, c.code] as const),
        ]);

        const to = dateOnly(new Date());
        const qtyMismatches: unknown[] = [];
        const balanceMismatches: unknown[] = [];
        let compared = 0;
        let rowsCompared = 0;
        let valueDiffItems = 0;
        const affected: unknown[] = [];
        for (const [key, movements] of byItem) {
          compared += 1;
          const avg = averageRows(movements);
          const peps = valuePeps(movements.map(toPeps), '2000-01-01', '9999-12-31');
          const pepsById = new Map(peps.rows.map((r) => [r.movementId, r]));
          const diffs = avg
            .map((a) => ({ a, p: pepsById.get(a.id) }))
            .filter(({ a, p }) => !p || toDecimal(p.balanceQty).cmp(toDecimal(a.balanceQty)) !== 0);
          rowsCompared += avg.length;
          if (diffs.length > 0) {
            qtyMismatches.push({
              item: label.get(key) ?? key,
              rows: diffs.length,
              first: diffs.slice(0, 3).map(({ a, p }) => ({
                movementId: a.id,
                average: a.balanceQty,
                peps: p?.balanceQty ?? null,
              })),
            });
          }
          const last = avg.at(-1);
          const bal = balanceOf.get(key);
          if (last && bal && toDecimal(bal.qty.toString()).cmp(toDecimal(last.balanceQty)) !== 0) {
            balanceMismatches.push({
              item: label.get(key) ?? key,
              kardex: last.balanceQty,
              balance: bal.qty.toString(),
            });
          }
          if (
            last &&
            toDecimal(peps.closing.total).minus(toDecimal(last.balanceValue)).abs().gt('0.01')
          ) {
            valueDiffItems += 1;
          }
          const rc = recost(movements);
          const recordedValue = bal
            ? toDecimal(bal.qty.toString()).times(bal.avgCost.toString())
            : ZERO;
          const inventoryDiff = rc.closingValue.minus(recordedValue);
          if (rc.changed > 0 || inventoryDiff.abs().gte('0.01')) {
            affected.push({
              item: label.get(key) ?? key,
              movementsChanged: rc.changed,
              costOfSalesDiffByMonth: Object.fromEntries(
                [...rc.byMonth].map(([k, v]) => [k, toFixedString(v, 'MONEY')]),
              ),
              inventoryRecorded: toFixedString(recordedValue, 'MONEY'),
              inventoryRecost: toFixedString(rc.closingValue, 'MONEY'),
              inventoryDiff: toFixedString(inventoryDiff, 'MONEY'),
              qty: rc.closingQty.toFixed(3),
              avgRecost: toFixedString(
                rc.closingQty.gt(0) ? rc.closingValue.div(rc.closingQty) : ZERO,
                'MONEY',
              ),
            });
          }
        }

        // Detalle del SKU pedido: las dos vistas, fila por fila.
        const product = products.find((p) => p.sku === sku);
        let detail: unknown = null;
        if (product) {
          const movements = byItem.get(`PRODUCT:${product.id}`) ?? [];
          const avg = averageRows(movements);
          const peps = valuePeps(movements.map(toPeps), '2000-01-01', to);
          const pepsById = new Map(peps.rows.map((r) => [r.movementId, r]));
          detail = {
            sku,
            balance: balanceOf.get(`PRODUCT:${product.id}`) ?? null,
            pepsClosing: peps.closing,
            pepsTotals: peps.totals,
            warnings: peps.warnings,
            rows: movements.map((m, i) => {
              const p = pepsById.get(m.id.toString());
              return {
                id: m.id.toString(),
                operationDate: dateOnly(m.operationDate),
                at: m.at.toISOString(),
                type: m.type,
                refType: m.refType,
                reversalOf: m.reversalOfId?.toString() ?? null,
                qty: m.qty.toString(),
                average: {
                  unitCost: m.unitCost.toString(),
                  totalCost: m.totalCost.toString(),
                  balanceQty: avg[i]?.balanceQty,
                  balanceValue: avg[i]?.balanceValue,
                  balanceAvg: avg[i]?.avg,
                },
                peps: p
                  ? {
                      inTotal: p.inTotal,
                      outUnitCost: p.outUnitCost,
                      outTotal: p.outTotal,
                      outLayers: p.outLayers,
                      balanceQty: p.balanceQty,
                      balanceTotal: p.balanceTotal,
                      warning: p.warning,
                    }
                  : null,
              };
            }),
          };
        }
        return {
          itemsCompared: compared,
          rowsCompared,
          qtyMismatches,
          balanceMismatches,
          itemsWithClosingValueDiff: valueDiffItems,
          affected,
          detail,
        };
      },
      { timeout: 120_000 },
    );
    console.log(JSON.stringify(report, null, 2));
    console.error(
      `Ítems: ${report.itemsCompared} · filas: ${report.rowsCompared} · con cantidad distinta: ${report.qtyMismatches.length} · saldo ≠ inventory_balances: ${report.balanceMismatches.length} · con valor final distinto: ${report.itemsWithClosingValueDiff}`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
