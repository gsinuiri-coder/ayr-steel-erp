/**
 * cc34 (B1) — diagnóstico histórico del despunte por bobina. **Solo lectura**: una transacción
 * `READ ONLY`, sin modo execute y sin reparar nada. Imprime un JSON en stdout (para guardarlo en
 * `local-data/cc34/diagnostico/`) y un resumen en stderr.
 *
 * Toma las órdenes de coberturas y accesorios **cerradas** con dos o más bobinas
 * soltadas por el cierre, y compara el SCRAP que cada bobina recibió de verdad contra el que daría
 * la regla nueva (`allocateRoofingScrap`), con la diferencia en kg y en soles por orden.
 *
 * Limitaciones (van en el JSON):
 * - El cierre no guarda si el consumo fue un total escrito o lo declarado por parte. Se infiere:
 *   si el consumo de la orden coincide con lo que daban los partes (regla vieja), fue por parte;
 *   si no, fue un total escrito.
 * - El saldo de cada fila al cerrar se reconstruye devolviéndole el SCRAP de su bobina; con una
 *   bobina montada dos veces en la misma orden, el reparto entre sus filas es aproximado (el total
 *   por bobina, que es lo que se compara, no).
 * - Los soles se valorizan al costo unitario con que salió el material de cada bobina en esa orden.
 */
import 'dotenv/config';
import { type Prisma, PrismaClient } from '@prisma/client';
import { Decimal, toDecimal } from '@ayr/shared';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import { allocateRoofingScrap } from '../src/production/roofing-scrap';

type Tx = Prisma.TransactionClient;

const dec = (v: Prisma.Decimal | null | undefined): Decimal =>
  v === null || v === undefined ? new Decimal(0) : toDecimal(v.toString());
const ZERO = new Decimal(0);

interface Movement {
  id: bigint;
  itemId: string;
  qty: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  totalCost: Prisma.Decimal;
  refId: string | null;
  reversalOfId: bigint | null;
  reversals: { id: bigint }[];
}
const live = (ms: Movement[]) =>
  ms.filter((m) => m.reversalOfId === null && m.reversals.length === 0);

async function scrapByCoil(tx: Tx) {
  const orders = await tx.productionOrder.findMany({
    // Autorrevisión de cc34 (P2-3): también las cerradas sin despunte: la compensación vieja entre
    // bobinas pudo dejarlo en 0 donde la regla nueva lo saca.
    where: { kind: 'ROOFING', status: 'CLOSED' },
    select: {
      id: true,
      seq: true,
      closedAt: true,
      closedOperationDate: true,
      consumedKg: true,
      scrapKg: true,
    },
    orderBy: { seq: 'asc' },
  });

  const results = [];
  let ordersWithDifference = 0;
  let movedKg = ZERO;
  let movedPen = ZERO;
  let netPen = ZERO;
  let multiCoil = 0;

  for (const order of orders) {
    const rows = await tx.productionOrderConsumption.findMany({
      where: { productionOrderId: order.id, releasedAt: order.closedAt },
      include: { coil: { select: { code: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const coilIds = [...new Set(rows.map((r) => r.coilId))];
    if (coilIds.length < 2) continue;
    multiCoil += 1;

    const reports = await tx.productionReport.findMany({
      where: { productionOrderId: order.id, status: 'ACTIVE' },
      select: { id: true, consumedKg: true, theoreticalKg: true },
    });
    const include = { reversals: { select: { id: true } } } as const;
    const productionOuts = live(
      await tx.inventoryMovement.findMany({
        where: {
          refType: 'PRODUCTION',
          refId: { in: reports.map((r) => r.id) },
          itemType: 'COIL',
          type: 'OUT',
        },
        include,
      }),
    );
    const scrapOuts = live(
      await tx.inventoryMovement.findMany({
        where: { refType: 'SCRAP', refId: order.id, itemType: 'COIL', type: 'OUT' },
        include,
      }),
    );

    const actual = new Map<string, Decimal>();
    const actualPen = new Map<string, Decimal>();
    const unitCost = new Map<string, Decimal>();
    for (const m of scrapOuts) {
      actual.set(m.itemId, (actual.get(m.itemId) ?? ZERO).plus(dec(m.qty)));
      actualPen.set(m.itemId, (actualPen.get(m.itemId) ?? ZERO).plus(dec(m.totalCost)));
      unitCost.set(m.itemId, dec(m.unitCost));
    }
    for (const m of productionOuts) {
      if (!unitCost.has(m.itemId)) unitCost.set(m.itemId, dec(m.unitCost));
    }

    // El saldo de cada fila **antes** del despunte: se le devuelve el SCRAP de su bobina, a la
    // primera fila de esa bobina.
    const givenBack = new Set<string>();
    const scrapRows = rows.map((r) => {
      let remaining = dec(r.assignedKg).minus(dec(r.consumedKg));
      if (!givenBack.has(r.coilId)) {
        remaining = remaining.plus(actual.get(r.coilId) ?? ZERO);
        givenBack.add(r.coilId);
      }
      return {
        consumptionId: r.id,
        coilId: r.coilId,
        coilCode: r.coil.code,
        remainingKg: Decimal.max(remaining, ZERO),
      };
    });

    const reportInputs = reports.map((r) => ({
      id: r.id,
      declaredKg: r.consumedKg === null ? null : dec(r.consumedKg),
      theoreticalKg: dec(r.theoreticalKg),
    }));
    const outs = productionOuts.flatMap((m) =>
      m.refId === null ? [] : [{ reportId: m.refId, coilId: m.itemId, kg: dec(m.qty) }],
    );

    // ¿Total escrito o declarado por parte? Lo que daban los partes con la regla vieja (D-146).
    const outByReport = new Map<string, Decimal>();
    for (const o of outs)
      outByReport.set(o.reportId, (outByReport.get(o.reportId) ?? ZERO).plus(o.kg));
    const reportedKg = reports.reduce(
      (a, r) => a.plus(outByReport.get(r.id) ?? dec(r.theoreticalKg)),
      ZERO,
    );
    const oldByReports = reports.some((r) => r.consumedKg !== null)
      ? Decimal.max(
          reports.reduce(
            (a, r) =>
              a.plus(
                r.consumedKg === null
                  ? (outByReport.get(r.id) ?? dec(r.theoreticalKg))
                  : dec(r.consumedKg),
              ),
            ZERO,
          ),
          reportedKg,
        )
      : reportedKg;
    const consumed = dec(order.consumedKg);
    const explicit = !consumed.equals(oldByReports);

    const planByCoil = (explicitTotalKg: Decimal | null) => {
      try {
        const plan = allocateRoofingScrap({
          rows: scrapRows,
          reports: reportInputs,
          outs,
          explicitTotalKg,
        });
        const byCoil = new Map<string, Decimal>();
        for (const a of plan.allocations) {
          byCoil.set(a.coilId, (byCoil.get(a.coilId) ?? ZERO).plus(a.kg));
        }
        return { byCoil, error: null };
      } catch (e) {
        return {
          byCoil: new Map<string, Decimal>(),
          error: e instanceof Error ? e.message : String(e),
        };
      }
    };
    const chosen = planByCoil(explicit ? consumed : null);
    const wouldBe = chosen.byCoil;
    const error = chosen.error;
    // Autorrevisión de cc34 (P2-4): si el total escrito coincide con lo que daban los partes, el
    // cierre pudo ser cualquiera de los dos. Se calcula también el otro y, si reparte distinto, la
    // orden se marca ambigua con las dos cifras.
    let ambiguousTotalWritten: Record<string, string> | null = null;
    if (!explicit && reports.some((r) => r.consumedKg !== null)) {
      const other = planByCoil(consumed);
      const same =
        other.error === null &&
        coilIds.every((c) => (other.byCoil.get(c) ?? ZERO).equals(wouldBe.get(c) ?? ZERO));
      if (!same) {
        ambiguousTotalWritten = Object.fromEntries(
          coilIds.map((c) => [c, (other.byCoil.get(c) ?? ZERO).toFixed(3)]),
        );
      }
    }

    const coils = coilIds.map((coilId) => {
      const now = actual.get(coilId) ?? ZERO;
      const next = wouldBe.get(coilId) ?? ZERO;
      const delta = next.minus(now);
      const cost = unitCost.get(coilId) ?? ZERO;
      return {
        coilId,
        coilCode: rows.find((r) => r.coilId === coilId)?.coil.code ?? null,
        actualScrapKg: now.toFixed(3),
        actualScrapPen: (actualPen.get(coilId) ?? ZERO).toFixed(2),
        newRuleScrapKg: next.toFixed(3),
        differenceKg: delta.toFixed(3),
        unitCostPen: cost.toFixed(4),
        differencePen: delta.times(cost).toFixed(2),
      };
    });
    const orderMovedKg = coils.reduce(
      (a, c) => a.plus(Decimal.max(toDecimal(c.differenceKg), ZERO)),
      ZERO,
    );
    const orderMovedPen = coils.reduce(
      (a, c) => a.plus(Decimal.max(toDecimal(c.differencePen), ZERO)),
      ZERO,
    );
    const orderNetPen = coils.reduce((a, c) => a.plus(toDecimal(c.differencePen)), ZERO);
    const differs = coils.some((c) => !toDecimal(c.differenceKg).isZero());
    if (differs) {
      ordersWithDifference += 1;
      movedKg = movedKg.plus(orderMovedKg);
      movedPen = movedPen.plus(orderMovedPen);
      netPen = netPen.plus(orderNetPen);
    }
    results.push({
      orderId: order.id,
      seq: order.seq,
      closedOperationDate: order.closedOperationDate?.toISOString().slice(0, 10) ?? null,
      consumedKg: consumed.toFixed(3),
      scrapKg: dec(order.scrapKg).toFixed(3),
      reportedKg: reportedKg.toFixed(3),
      closeInferredAs: explicit ? 'TOTAL_ESCRITO' : 'DECLARADO_POR_PARTE',
      reports: reports.length,
      coils,
      differs,
      movedKg: orderMovedKg.toFixed(3),
      movedPen: orderMovedPen.toFixed(2),
      netPen: orderNetPen.toFixed(2),
      newRuleError: error,
      ambiguousTotalWritten,
    });
  }

  return {
    closed: orders.length,
    closedWithScrap: orders.filter((o) => dec(o.scrapKg).gt(0)).length,
    multiCoil,
    ordersWithDifference,
    ambiguousOrders: results.filter((r) => r.ambiguousTotalWritten !== null).length,
    movedKg: movedKg.toFixed(3),
    movedPen: movedPen.toFixed(2),
    netPen: netPen.toFixed(2),
    note: 'movedKg/movedPen: kilos y soles que la regla nueva cambia de bobina o agrega (suma de las diferencias positivas). netPen: cambio neto del costo del despunte de la orden (≠ 0 si las bobinas tenían costos distintos o si cambia el total). ambiguousTotalWritten: el reparto si el cierre hubiera sido un total escrito igual a lo declarado. El tipo de cierre se infiere (ver encabezado del CLI).',
    orders: results,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 0) {
    throw new Error(`Este subcomando es solo lectura y no acepta argumentos: ${args[0] ?? ''}`);
  }
  assertExecuteAllowed(false);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  const branch = process.env.AYR_CLI_BRANCH;
  if (!branch) throw new Error('Ejecutá este subcomando mediante runApiCli');
  const db = new PrismaClient();
  try {
    const report = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return {
          branch,
          takenAt: new Date().toISOString(),
          scrapByCoil: await scrapByCoil(tx),
        };
      },
      { timeout: 120_000 },
    );
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    console.error(`Rama ${branch}; foto ${report.takenAt}; transacción READ ONLY`);
    const s = report.scrapByCoil;
    console.error(
      `B1. Cerradas: ${s.closed} (con despunte ${s.closedWithScrap}); con 2+ bobinas: ${s.multiCoil}; ` +
        `con diferencia: ${s.ordersWithDifference}, ambiguas ${s.ambiguousOrders} (${s.movedKg} kg cambian de bobina, S/ ${s.movedPen}; neto S/ ${s.netPen})`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
