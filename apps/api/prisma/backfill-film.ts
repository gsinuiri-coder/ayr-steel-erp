/* eslint-disable no-console -- script operacional: reporta sus conteos. */
// D-328: backfill del film de protección sobre las bobinas anteriores a la función.
//
// Todas las bobinas existentes quedan «selladas» por la migración (default `film_sealed = true`,
// sin eventos). Este script deduce cuáles se **abrieron** de verdad, con la regla del dueño:
//
//   - «Abierta» si tuvo una salida viva de producción, merma, partido o corte, con el evento
//     `OPENED` fechado en **la primera**.
//   - Las terminadas cuya única salida es una venta no reciben evento: quedan «Terminada» por
//     estado y el reporte mensual las ubica en «Abiertas».
//   - «Sellada» todo el resto.
//   - (Por coherencia con las reglas nuevas, dichas en el dry-run con su motivo para que se
//     puedan vetar) la bobina que **nació abierta** —hija de partido, fleje de corte—, la que hoy
//     está enviada a corte y la que está montada en una OP viva también reciben su `OPENED`.
//
// La clasificación es la función pura `classifyBackfill` (probada aparte); este archivo solo
// junta los hechos de la base, la aplica y escribe. Idempotente: una bobina que ya tiene eventos
// no se toca, así que repetir la corrida no duplica nada.
//
// Dry-run por defecto. `--execute` escribe los eventos vía `recordFilmEvent`, en una sola
// transacción. La lista completa del dry-run va a `local-data/corr04b/film-dry-run-<rama>.txt`
// para que el dueño la revise antes del execute.
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient, ProductionOrderStatus } from '@prisma/client';
import { businessToday, fromDateOnly } from '@ayr/shared';
import {
  classifyBackfill,
  recordFilmEvent,
  USE_REF_TYPES,
  type BackfillDecision,
} from '../src/coils/coil-film';

const prisma = new PrismaClient();
const execute = process.argv.includes('--execute');
const branchLabel = process.env.AYR_BRANCH_LABEL ?? '(sin etiqueta)';

interface PlannedCoil {
  id: string;
  code: string;
  kind: string;
  status: string;
  availableKg: string;
  /** Fecha de la última salida viva de uso o venta, para listar las agotadas que siguen vigentes. */
  lastOutflowOn: string | null;
  decision: BackfillDecision;
}

async function plan(): Promise<PlannedCoil[]> {
  const coils = await prisma.coil.findMany({
    select: {
      id: true,
      code: true,
      kind: true,
      status: true,
      parentCoilId: true,
      operationDate: true,
      _count: { select: { filmEvents: true } },
    },
    orderBy: { code: 'asc' },
  });

  // Salidas vivas (ni anuladas ni la anulación de otra) de cualquier bobina, en una consulta.
  const movements = await prisma.inventoryMovement.findMany({
    where: {
      itemType: 'COIL',
      type: 'OUT',
      refType: { in: [...USE_REF_TYPES, 'SALE'] },
      reversalOfId: null,
      reversals: { none: {} },
    },
    select: { itemId: true, refType: true, operationDate: true },
  });
  const outflowsByCoil = new Map<string, { refType: string; operationDate: string }[]>();
  for (const m of movements) {
    const list = outflowsByCoil.get(m.itemId) ?? [];
    list.push({ refType: m.refType, operationDate: fromDateOnly(m.operationDate) });
    outflowsByCoil.set(m.itemId, list);
  }

  const sent = await prisma.cuttingOrderCoil.findMany({
    where: { status: 'SENT' },
    select: { coilId: true, cuttingOrder: { select: { operationDate: true } } },
  });
  const sentByCoil = new Map(
    sent.map((s) => [s.coilId, fromDateOnly(s.cuttingOrder.operationDate)] as const),
  );

  const mounts = await prisma.productionOrderConsumption.findMany({
    where: {
      releasedAt: null,
      productionOrder: {
        status: { in: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS] },
      },
    },
    select: { coilId: true, createdAt: true },
  });
  const mountedByCoil = new Map<string, string>();
  for (const m of mounts) {
    const day = businessToday(m.createdAt);
    const prev = mountedByCoil.get(m.coilId);
    if (prev === undefined || day < prev) mountedByCoil.set(m.coilId, day);
  }

  const balances = await prisma.inventoryBalance.findMany({
    where: { itemType: 'COIL' },
    select: { itemId: true, qty: true },
  });
  const availableByCoil = new Map(balances.map((b) => [b.itemId, b.qty.toFixed(3)]));

  return coils.map((c) => ({
    id: c.id,
    code: c.code,
    kind: c.kind,
    status: c.status,
    availableKg: availableByCoil.get(c.id) ?? '0.000',
    lastOutflowOn:
      (outflowsByCoil.get(c.id) ?? [])
        .map((o) => o.operationDate)
        .sort()
        .at(-1) ?? null,
    decision: classifyBackfill({
      status: c.status,
      bornOpen: c.parentCoilId !== null,
      operationDate: fromDateOnly(c.operationDate),
      outflows: outflowsByCoil.get(c.id) ?? [],
      sentToCuttingOn: sentByCoil.get(c.id) ?? null,
      mountedOn: mountedByCoil.get(c.id) ?? null,
      hasEvents: c._count.filmEvents > 0,
    }),
  }));
}

function describe(p: PlannedCoil): string {
  const d = p.decision;
  const what =
    d.action === 'OPEN'
      ? `ABRIR el ${d.operationDate ?? '?'} (${d.reason})`
      : `sin evento (${d.reason})`;
  return `${p.code.padEnd(34)} ${p.kind.padEnd(5)} ${p.status.padEnd(15)} ${p.availableKg.padStart(11)} kg  ${what}`;
}

async function stateCounts(): Promise<string[]> {
  const rows = await prisma.coil.groupBy({
    by: ['status', 'filmSealed'],
    _count: { _all: true },
    orderBy: [{ status: 'asc' }, { filmSealed: 'asc' }],
  });
  return rows.map((r) => {
    const label =
      r.status === 'OPEN'
        ? r.filmSealed
          ? 'Selladas (vigentes)'
          : 'Abiertas (vigentes)'
        : r.status === 'CLOSED'
          ? `Terminadas (film ${r.filmSealed ? 'sellado' : 'abierto'})`
          : `${r.status} (film ${r.filmSealed ? 'sellado' : 'abierto'})`;
    return `  ${String(r._count._all).padStart(5)}  ${label}`;
  });
}

async function main(): Promise<void> {
  const planned = await plan();
  const toOpen = planned.filter((p) => p.decision.action === 'OPEN');

  const byReason = new Map<string, number>();
  for (const p of planned) {
    byReason.set(p.decision.reason, (byReason.get(p.decision.reason) ?? 0) + 1);
  }

  // Categorías **excluyentes**: cada bobina tiene una sola decisión, y la suma tiene que dar el total.
  const byCategory = new Map<string, number>();
  for (const p of planned) {
    const key = `${p.decision.action === 'OPEN' ? 'ABRIR' : 'sin evento'} · ${p.decision.reason} · ${p.status}`;
    byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
  }
  const categorySum = [...byCategory.values()].reduce((a, b) => a + b, 0);
  // Vigentes sin saldo: agotadas que nadie terminó. No se tocan en la ventana (decisión del dueño).
  const exhausted = planned.filter((p) => p.status === 'OPEN' && Number(p.availableKg) <= 0);

  const lines: string[] = [];
  lines.push(
    `Backfill del film (D-328) — rama ${branchLabel} — ${execute ? 'EXECUTE' : 'DRY-RUN'}`,
    `Bobinas: ${planned.length}. A abrir: ${toOpen.length}. Sin evento: ${planned.length - toOpen.length}.`,
    '',
    'Por motivo:',
    ...[...byReason.entries()].sort().map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`),
    '',
    'Categorías (excluyentes; suman el total):',
    ...[...byCategory.entries()].sort().map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`),
    `  ${String(categorySum).padStart(5)}  = TOTAL (${categorySum === planned.length ? 'coincide' : 'NO COINCIDE'} con ${planned.length} bobinas)`,
    '',
    'Estado actual:',
    ...(await stateCounts()),
    '',
    `Vigentes con saldo 0 (${exhausted.length}) — pendientes del dueño, terminar desde la pantalla (código, saldo, última salida):`,
    ...exhausted.map(
      (p) =>
        `  ${p.code.padEnd(34)} ${p.availableKg.padStart(11)} kg  última salida: ${p.lastOutflowOn ?? '—'}`,
    ),
    '',
    'Detalle (código, clase, estado, saldo, decisión):',
    ...planned.map(describe),
  );
  console.log(lines.join('\n'));

  const outDir = resolve(process.cwd(), '../../local-data/corr04b');
  mkdirSync(outDir, { recursive: true });
  const safeBranch = branchLabel.replace(/[^a-zA-Z0-9_-]/g, '_');
  const outFile = resolve(outDir, `film-dry-run-${safeBranch}.txt`);
  writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  console.log(`\nLista escrita en ${outFile}`);

  if (!execute) {
    console.log('\nDry-run: no se escribió nada. Repetir con --execute para aplicar el backfill.');
    return;
  }

  await prisma.$transaction(
    async (tx) => {
      for (const p of toOpen) {
        if (!p.decision.operationDate || !p.decision.source) continue;
        // Revisión independiente (B-5): el plan se leyó fuera de esta transacción. Si entre el
        // plan y el execute alguien abrió o resello la bobina, ese historial manda: no se toca.
        if ((await tx.coilFilmEvent.count({ where: { coilId: p.id } })) > 0) continue;
        await recordFilmEvent(tx, {
          coilId: p.id,
          type: 'OPENED',
          source: p.decision.source,
          operationDate: p.decision.operationDate,
          actorId: null,
          reason: `Deducida del historial (D-328): ${p.decision.reason}`,
        });
      }
    },
    { timeout: 120_000 },
  );

  console.log(`\nEventos escritos: ${toOpen.length}`);
  console.log('Estado después:');
  console.log((await stateCounts()).join('\n'));

  // Idempotencia: una segunda pasada no debe encontrar nada que abrir.
  const again = (await plan()).filter((p) => p.decision.action === 'OPEN');
  if (again.length > 0) {
    throw new Error(`Quedaron ${again.length} bobinas por abrir tras el execute: revisar.`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
