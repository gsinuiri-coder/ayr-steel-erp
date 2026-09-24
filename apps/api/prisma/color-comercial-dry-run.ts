/* eslint-disable no-console -- guion de diagnostico: su salida ES la consola. */
/**
 * Dry-run de **solo lectura** del paso a color comercial en producción y reservas (diseño
 * `docs/diseno/color-comercial-produccion.md` §4). No escribe nada: toda la lectura corre en
 * una transacción `READ ONLY`, así que un error de este guion no puede tocar la base aunque
 * alguien le agregue una escritura por descuido — Postgres la rechaza.
 *
 * Las ocho salidas del diseño:
 *   1. colores y su color comercial (`COMMERCIAL_COLOR_SQL` contra `commercialColorToken`);
 *   2. specs que se funden;
 *   3. specs sin color que se parten en NATURAL y GALVANIZADO;
 *   4. agregado antes y después, en kg;
 *   5. OPs de coberturas vivas y si su bobina montada sigue coincidiendo;
 *   6. faltantes de cotizaciones emitidas, antes y después;
 *   7. piso de precio de las líneas abiertas que se mueve, en soles;
 *   8. inventario valorizado de bobinas, agrupado como hoy y por color comercial.
 * Además: la hipótesis del dueño (los acabados de un mismo color comercial difieren solo en el
 * tono) contrastada contra densidad y línea de cada acabado.
 *
 * Uso: `node scripts/color-comercial-dry-run.mjs --branch production|demo|dev|local|local-e2e`.
 * La salida completa queda además en `local-data/color-comercial/<rama>-<fecha>.json`.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  Decimal,
  ROOFING_THICKNESS_TOLERANCE_MM,
  minAllowedValue,
  quotationCode,
  salesOrderCode,
  productionOrderCode,
  toDecimal,
} from '@ayr/shared';
import {
  buildPlan,
  checkMounted,
  COMMERCIAL_COLOR_SQL,
  floorCoils,
  materialKeyOf,
  planColors,
  weightedCostPerKg,
  type PlanCoil,
  type PlanFinishKind,
  type PlanReservation,
  type PlanSpec,
} from '../src/catalog/commercial-color-plan';
import {
  orderedMeters,
  ROOFING_PRODUCT_SELECT,
  theoreticalKgForMeters,
} from '../src/sales/sales-lines';

const prisma = new PrismaClient();
type Tx = Prisma.TransactionClient;

const label = process.env.AYR_BRANCH_LABEL ?? 'local';
// Vacía cuenta como ausente, igual que `roofingToleranceMm`.
const envTolerance = process.env.ROOFING_THICKNESS_TOLERANCE_MM ?? '';
const toleranceMm = envTolerance === '' ? ROOFING_THICKNESS_TOLERANCE_MM : envTolerance;

interface ColorRow {
  id: string;
  code: string;
  name: string;
  ral_code: string | null;
  sql_commercial: string;
}

async function loadColors(tx: Tx): Promise<ColorRow[]> {
  return tx.$queryRawUnsafe<ColorRow[]>(
    `SELECT "id", "code", "name", "ral_code", ${COMMERCIAL_COLOR_SQL} AS "sql_commercial"
       FROM "colors" ORDER BY "code"`,
  );
}

async function loadCoils(tx: Tx, commercialById: Map<string, string>): Promise<PlanCoil[]> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      code: string;
      business_line_id: string;
      thickness_mm: Prisma.Decimal;
      color_id: string | null;
      kind: PlanFinishKind;
      ral_code: string | null;
      qty: Prisma.Decimal | null;
      avg_cost: Prisma.Decimal | null;
    }[]
  >`
    SELECT c."id", c."code", c."business_line_id", c."thickness_mm", c."color_id",
           f."kind"::text AS "kind", col."ral_code", b."qty", b."avg_cost"
      FROM "coils" c
      JOIN "finishes" f ON f."id" = c."finish_id"
      LEFT JOIN "colors" col ON col."id" = c."color_id"
      LEFT JOIN "inventory_balances" b ON b."item_type" = 'COIL' AND b."item_id" = c."id"
     WHERE c."kind" = 'COIL' AND c."status" = 'OPEN'
     ORDER BY c."code"`;
  const held = await tx.$queryRaw<{ coil_id: string; held: Prisma.Decimal }[]>`
    SELECT pc."coil_id", SUM(GREATEST(pc."assigned_kg" - pc."consumed_kg", 0)) AS "held"
      FROM "production_order_consumptions" pc
      JOIN "production_orders" po ON po."id" = pc."production_order_id"
     WHERE pc."released_at" IS NULL AND po."status" IN ('DRAFT', 'IN_PROGRESS')
       AND po."reservation_id" IS NULL
     GROUP BY pc."coil_id"`;
  const onCoil = await tx.$queryRaw<{ item_id: string; qty: Prisma.Decimal }[]>`
    SELECT "item_id", SUM("qty") AS "qty" FROM (
      SELECT "item_id", "qty" FROM "reservations"
       WHERE "item_type" = 'COIL' AND "status" = 'ACTIVE'
      UNION ALL
      SELECT "item_id", "qty" FROM "quotation_reservations"
       WHERE "item_type" = 'COIL' AND "status" = 'ACTIVE' AND "expires_at" > now()
    ) r GROUP BY "item_id"`;
  const heldById = new Map(held.map((h) => [h.coil_id, h.held.toFixed(3)]));
  const onCoilById = new Map(onCoil.map((r) => [r.item_id, r.qty.toFixed(3)]));
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    businessLineId: r.business_line_id,
    thicknessMm: r.thickness_mm.toFixed(2),
    colorId: r.color_id,
    kind: r.kind,
    commercialColor: r.color_id === null ? null : (commercialById.get(r.color_id) ?? null),
    ralCode: r.ral_code,
    balanceKg: (r.qty ?? new Prisma.Decimal(0)).toFixed(3),
    avgCostPen: (r.avg_cost ?? new Prisma.Decimal(0)).toFixed(4),
    heldKg: heldById.get(r.id) ?? '0.000',
    reservedOnCoilKg: onCoilById.get(r.id) ?? '0.000',
  }));
}

async function loadSpecs(tx: Tx): Promise<PlanSpec[]> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      business_line_id: string;
      color_id: string | null;
      thickness_mm: Prisma.Decimal;
      quotation_lines: bigint;
      sales_order_lines: bigint;
      kinds: string[] | null;
    }[]
  >`
    SELECT s."id", s."business_line_id", s."color_id", s."thickness_mm",
           (SELECT COUNT(*) FROM "quotation_items" qi
             WHERE qi."reserve_item_type" = 'RAW_MATERIAL' AND qi."reserve_item_id" = s."id") AS "quotation_lines",
           (SELECT COUNT(*) FROM "sales_order_items" si
             WHERE si."reserve_item_type" = 'RAW_MATERIAL' AND si."reserve_item_id" = s."id") AS "sales_order_lines",
           (SELECT array_agg(DISTINCT f."kind"::text) FROM (
               SELECT qi."product_id" FROM "quotation_items" qi
                WHERE qi."reserve_item_type" = 'RAW_MATERIAL' AND qi."reserve_item_id" = s."id"
               UNION
               SELECT si."product_id" FROM "sales_order_items" si
                WHERE si."reserve_item_type" = 'RAW_MATERIAL' AND si."reserve_item_id" = s."id"
             ) l
             JOIN "products" p ON p."id" = l."product_id"
             JOIN "finishes" f ON f."id" = p."finish_id") AS "kinds"
      FROM "raw_material_specs" s
     ORDER BY s."business_line_id", s."thickness_mm", s."color_id" NULLS FIRST`;
  return rows.map((r) => ({
    id: r.id,
    businessLineId: r.business_line_id,
    colorId: r.color_id,
    thicknessMm: r.thickness_mm.toFixed(2),
    quotationLines: Number(r.quotation_lines),
    salesOrderLines: Number(r.sales_order_lines),
    lineKinds: (r.kinds ?? []) as PlanFinishKind[],
  }));
}

async function loadReservations(
  tx: Tx,
  commercialById: Map<string, string>,
): Promise<PlanReservation[]> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      temporary: boolean;
      spec_id: string;
      qty: Prisma.Decimal;
      seq: number;
      document_id: string;
      sku: string;
      kind: PlanFinishKind | null;
      color_id: string | null;
    }[]
  >`
    SELECT r."id", false AS "temporary", r."item_id" AS "spec_id", r."qty", so."seq",
           so."id" AS "document_id", p."sku", f."kind"::text AS "kind", p."color_id"
      FROM "reservations" r
      JOIN "sales_orders" so ON so."id" = r."sales_order_id"
      JOIN "sales_order_items" si ON si."id" = r."sales_order_item_id"
      JOIN "products" p ON p."id" = si."product_id"
      LEFT JOIN "finishes" f ON f."id" = p."finish_id"
     WHERE r."item_type" = 'RAW_MATERIAL' AND r."status" = 'ACTIVE'
    UNION ALL
    SELECT qr."id", true, qr."item_id", qr."qty", q."seq", q."id", p."sku", f."kind"::text,
           p."color_id"
      FROM "quotation_reservations" qr
      JOIN "quotations" q ON q."id" = qr."quotation_id"
      JOIN "quotation_items" qi ON qi."quotation_id" = qr."quotation_id"
                               AND qi."line_number" = qr."line_number"
      JOIN "products" p ON p."id" = qi."product_id"
      LEFT JOIN "finishes" f ON f."id" = p."finish_id"
     WHERE qr."item_type" = 'RAW_MATERIAL' AND qr."status" = 'ACTIVE' AND qr."expires_at" > now()`;
  return rows.map((r) => ({
    id: r.id,
    temporary: r.temporary,
    specId: r.spec_id,
    qtyKg: r.qty.toFixed(3),
    documentCode: r.temporary ? quotationCode(r.seq) : salesOrderCode(r.seq),
    documentId: r.document_id,
    productSku: r.sku,
    productKind: r.kind,
    productCommercialColor: r.color_id === null ? null : (commercialById.get(r.color_id) ?? null),
    productColorId: r.color_id,
  }));
}

/** La hipótesis del dueño: dentro de un color comercial, los acabados difieren solo en el tono. */
async function finishesByCommercialColor(tx: Tx, commercialById: Map<string, string>) {
  // Todos los acabados, de todos los tipos: la llave nueva junta un tipo sin color con un color
  // comercial que se llame igual, y eso solo se ve mirando los dos lados a la vez.
  const rows = await tx.$queryRaw<
    {
      code: string;
      name: string;
      kind: PlanFinishKind;
      density_factor: Prisma.Decimal;
      business_line: string;
      color_id: string | null;
      color_code: string | null;
      color_name: string | null;
      is_active: boolean;
      open_coils: bigint;
      products: bigint;
    }[]
  >`
    SELECT f."code", f."name", f."kind"::text AS "kind", f."density_factor",
           bl."code"::text AS "business_line", f."color_id", col."code" AS "color_code",
           col."name" AS "color_name", f."is_active",
           (SELECT COUNT(*) FROM "coils" c
             WHERE c."finish_id" = f."id" AND c."kind" = 'COIL' AND c."status" = 'OPEN') AS "open_coils",
           (SELECT COUNT(*) FROM "products" p WHERE p."finish_id" = f."id") AS "products"
      FROM "finishes" f
      LEFT JOIN "colors" col ON col."id" = f."color_id"
      JOIN "business_lines" bl ON bl."id" = f."business_line_id"
     ORDER BY f."kind", col."code" NULLS FIRST, f."code"`;
  const byGroup = new Map<string, typeof rows>();
  for (const r of rows) {
    const commercial = r.color_id === null ? null : (commercialById.get(r.color_id) ?? null);
    const key = materialKeyOf(r.kind, commercial) ?? '?';
    byGroup.set(key, [...(byGroup.get(key) ?? []), r]);
  }
  return [...byGroup.entries()].map(([commercial, finishes]) => {
    // Por línea: el mismo color vive a propósito en dos líneas con la misma densidad (D-203).
    const densitiesByLine = new Map<string, Set<string>>();
    for (const f of finishes) {
      const set = densitiesByLine.get(f.business_line) ?? new Set<string>();
      set.add(f.density_factor.toFixed(4));
      densitiesByLine.set(f.business_line, set);
    }
    const colors = new Set(finishes.flatMap((f) => (f.color_code === null ? [] : [f.color_code])));
    return {
      commercial,
      colors: [...colors].sort(),
      finishes: finishes.map((f) => ({
        code: f.code,
        name: f.name,
        kind: f.kind,
        color: f.color_code ?? '-',
        colorName: f.color_name ?? '-',
        line: f.business_line,
        densityFactor: f.density_factor.toFixed(4),
        active: f.is_active,
        openCoils: Number(f.open_coils),
        products: Number(f.products),
      })),
      /** Un tipo sin color y un prepintado caen en la misma llave: la llave no los distingue. */
      kindCollision: new Set(finishes.map((f) => f.kind === 'PREPINTADO')).size > 1,
      mixedDensity: [...densitiesByLine.values()].some((s) => s.size > 1),
      /** Palabras que delatan otra cosa que el tono (brillo, textura). */
      suspiciousNames: finishes
        .filter((f) =>
          /MATE|BRILL|TEXTUR|RUGOS|SATIN|PVDF|POLIE/i.test(`${f.name} ${f.color_name}`),
        )
        .map((f) => `${f.code} (${f.name} / ${f.color_name ?? '-'})`),
    };
  });
}

async function loadMounted(tx: Tx, commercialById: Map<string, string>) {
  const rows = await tx.$queryRaw<
    {
      seq: number;
      sku: string;
      product_color_id: string | null;
      product_kind: PlanFinishKind | null;
      coil_code: string;
      coil_color_id: string | null;
      coil_kind: PlanFinishKind;
    }[]
  >`
    SELECT po."seq", p."sku", p."color_id" AS "product_color_id", pf."kind"::text AS "product_kind",
           c."code" AS "coil_code", c."color_id" AS "coil_color_id", cf."kind"::text AS "coil_kind"
      FROM "production_order_consumptions" pc
      JOIN "production_orders" po ON po."id" = pc."production_order_id"
      JOIN "products" p ON p."id" = po."product_id"
      LEFT JOIN "finishes" pf ON pf."id" = p."finish_id"
      JOIN "coils" c ON c."id" = pc."coil_id"
      JOIN "finishes" cf ON cf."id" = c."finish_id"
     WHERE po."kind" = 'ROOFING' AND po."status" IN ('DRAFT', 'IN_PROGRESS')
       AND pc."released_at" IS NULL
     ORDER BY po."seq"`;
  const liveOrders = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS "n" FROM "production_orders"
     WHERE "kind" = 'ROOFING' AND "status" IN ('DRAFT', 'IN_PROGRESS')`;
  return {
    liveRoofingOrders: Number(liveOrders[0]?.n ?? 0),
    rows: checkMounted(
      rows.map((r) => ({
        orderCode: productionOrderCode(r.seq),
        productSku: r.sku,
        productColorId: r.product_color_id,
        productKind: r.product_kind,
        productCommercialColor:
          r.product_color_id === null ? null : (commercialById.get(r.product_color_id) ?? null),
        coilCode: r.coil_code,
        coilColorId: r.coil_color_id,
        coilKind: r.coil_kind,
        coilCommercialColor:
          r.coil_color_id === null ? null : (commercialById.get(r.coil_color_id) ?? null),
      })),
    ),
  };
}

/** Líneas abiertas de materia prima: cotizaciones emitidas/borrador y pedidos vivos. */
async function loadOpenRawLines(tx: Tx) {
  const quotationItems = await tx.quotationItem.findMany({
    where: {
      reserveItemType: 'RAW_MATERIAL',
      quotation: { status: { in: ['DRAFT', 'EMITTED'] } },
    },
    select: {
      lineNumber: true,
      qty: true,
      unitPricePen: true,
      reserveQty: true,
      reserveItemId: true,
      productId: true,
      quotation: { select: { id: true, seq: true, status: true, validUntil: true } },
    },
  });
  const orderItems = await tx.salesOrderItem.findMany({
    where: {
      reserveItemType: 'RAW_MATERIAL',
      salesOrder: { status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_FULFILLED'] } },
    },
    select: {
      lineNumber: true,
      qty: true,
      unitPricePen: true,
      reserveQty: true,
      reserveItemId: true,
      productId: true,
      salesOrder: { select: { id: true, seq: true, status: true } },
    },
  });
  const productIds = [...new Set([...quotationItems, ...orderItems].map((i) => i.productId))];
  const products = await tx.product.findMany({
    where: { id: { in: productIds } },
    select: { ...ROOFING_PRODUCT_SELECT, finish: { select: { densityFactor: true, kind: true } } },
  });
  return { quotationItems, orderItems, productById: new Map(products.map((p) => [p.id, p])) };
}

async function valuationGroups(tx: Tx, commercialById: Map<string, string>) {
  const rows = await tx.$queryRaw<
    {
      qty: Prisma.Decimal;
      avg_cost: Prisma.Decimal;
      line: string;
      thickness_mm: Prisma.Decimal;
      color_id: string | null;
      color_name: string | null;
      kind: string;
    }[]
  >`
    SELECT b."qty", b."avg_cost", bl."code"::text AS "line", c."thickness_mm", c."color_id",
           col."name" AS "color_name", f."kind"::text AS "kind"
      FROM "inventory_balances" b
      JOIN "coils" c ON c."id" = b."item_id"
      JOIN "finishes" f ON f."id" = c."finish_id"
      JOIN "business_lines" bl ON bl."id" = c."business_line_id"
      LEFT JOIN "colors" col ON col."id" = c."color_id"
     WHERE b."item_type" = 'COIL' AND b."qty" <> 0`;
  const today = new Map<string, Decimal>();
  const after = new Map<string, Decimal>();
  let total = new Decimal(0);
  for (const r of rows) {
    const value = toDecimal(r.qty.toString()).times(toDecimal(r.avg_cost.toString()));
    total = total.plus(value);
    const t = r.thickness_mm.toFixed(2);
    const k1 = `${r.line}|${t}|${r.color_name ?? ''}`;
    const commercial = r.color_id === null ? null : (commercialById.get(r.color_id) ?? null);
    const k2 = `${r.line}|${t}|${materialKeyOf(r.kind as PlanFinishKind, commercial) ?? '?'}`;
    today.set(k1, (today.get(k1) ?? new Decimal(0)).plus(value));
    after.set(k2, (after.get(k2) ?? new Decimal(0)).plus(value));
  }
  const sum = (m: Map<string, Decimal>) =>
    [...m.values()].reduce((a, b) => a.plus(b), new Decimal(0));
  return {
    rows: rows.length,
    totalPen: total.toFixed(4),
    groupsToday: today.size,
    groupsAfter: after.size,
    totalTodayPen: sum(today).toFixed(4),
    totalAfterPen: sum(after).toFixed(4),
    after: [...after.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => ({ key, valuePen: v.toFixed(2) })),
  };
}

function kg(d: Decimal): string {
  return d.toFixed(3);
}

async function main(): Promise<void> {
  const report = await prisma.$transaction(
    async (tx) => {
      // La garantía de solo lectura: cualquier escritura dentro de esta transacción falla.
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');

      const colors = planColors(
        (await loadColors(tx)).map((c) => ({
          id: c.id,
          code: c.code,
          name: c.name,
          ralCode: c.ral_code,
          sqlCommercialColor: c.sql_commercial,
        })),
      );
      const commercialById = new Map(colors.map((c) => [c.id, c.commercialColor]));
      const coils = await loadCoils(tx, commercialById);
      const specs = await loadSpecs(tx);
      const reservations = await loadReservations(tx, commercialById);
      const plan = buildPlan({ colors, coils, specs, reservations, toleranceMm });
      const hypothesis = await finishesByCommercialColor(tx, commercialById);
      const mounted = await loadMounted(tx, commercialById);
      const lines = await loadOpenRawLines(tx);
      const valuation = await valuationGroups(tx, commercialById);
      const margins = await tx.pricingSetting.findMany({
        select: { businessLineId: true, minMarginPct: true },
      });
      const lineNames = new Map(
        (await tx.businessLine.findMany({ select: { id: true, code: true } })).map((l) => [
          l.id,
          l.code,
        ]),
      );
      return {
        colors,
        coils,
        specs,
        reservations,
        plan,
        hypothesis,
        mounted,
        lines,
        valuation,
        margins,
        lineNames,
      };
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  const { colors, coils, specs, reservations, plan, hypothesis, mounted, lines, valuation } =
    report;
  const lineName = (id: string): string => report.lineNames.get(id) ?? id.slice(0, 8);
  const minMarginByLine = new Map(
    report.margins.map((m) => [m.businessLineId, m.minMarginPct.toFixed(4)]),
  );
  const specById = new Map(specs.map((s) => [s.id, s]));
  const colorById = new Map(colors.map((c) => [c.id, c]));

  console.log(`=== Dry-run color comercial — ${label} — tolerancia ±${toleranceMm} mm ===`);
  console.log(
    `bobinas COIL abiertas: ${coils.length} · specs: ${specs.length} · reservas vivas de MP: ${reservations.length}`,
  );

  // 1. Colores
  console.log('\n[1] Colores y color comercial propuesto');
  for (const c of colors) {
    const flag = c.mismatch ? '  ← SQL≠TS' : c.empty ? '  ← VACÍO' : '';
    console.log(
      `  ${c.code.padEnd(20)} ${c.name.padEnd(24)} RAL ${(c.ralCode ?? '-').padEnd(6)} → ${c.commercialColor}${flag}`,
    );
  }
  const commercialGroups = new Map<string, string[]>();
  for (const c of colors) {
    commercialGroups.set(c.commercialColor, [
      ...(commercialGroups.get(c.commercialColor) ?? []),
      c.code,
    ]);
  }
  console.log('  Colores comerciales con más de un color del maestro:');
  for (const [g, codes] of commercialGroups) {
    if (codes.length > 1) console.log(`    ${g}: ${codes.join(', ')}`);
  }

  // Hipótesis del dueño
  console.log('\n[H] Acabados por color comercial (hipótesis: solo difieren en el tono)');
  for (const h of hypothesis) {
    console.log(
      `  ${h.commercial}: colores ${h.colors.join(', ') || '-'} · densidad mezclada en una línea: ${h.mixedDensity ? 'SÍ' : 'no'}` +
        (h.kindCollision ? ' · TIPO Y COLOR EN LA MISMA LLAVE' : '') +
        (h.suspiciousNames.length > 0
          ? ` · nombres a revisar: ${h.suspiciousNames.join('; ')}`
          : ''),
    );
    for (const f of h.finishes) {
      console.log(
        `      ${f.code.padEnd(22)} ${f.kind.padEnd(11)} ${f.line.padEnd(17)} dens ${f.densityFactor} color ${f.color.padEnd(9)} bobinas abiertas ${String(f.openCoils).padStart(3)} · productos ${String(f.products).padStart(3)} · ${f.name}${f.active ? '' : ' (inactivo)'}`,
      );
    }
  }

  // 2. Specs que se funden
  const describeSpec = (id: string): string => {
    const s = specById.get(id);
    if (!s) return id;
    const color = s.colorId === null ? 'sin color' : (colorById.get(s.colorId)?.code ?? s.colorId);
    return `${color} ${s.thicknessMm} (${s.quotationLines} lín. cot., ${s.salesOrderLines} lín. ped.)`;
  };
  console.log('\n[2] Specs que se funden');
  if (plan.merges.length === 0) console.log('  ninguna');
  for (const g of plan.merges) {
    console.log(`  ${lineName(g.businessLineId)} ${g.materialKey} ${g.thicknessMm} mm ←`);
    for (const id of g.sourceSpecIds) console.log(`      ${describeSpec(id)}`);
    for (const r of g.reservations) {
      console.log(
        `      reserva ${r.temporary ? 'temporal' : 'firme'} ${r.documentCode} ${r.productSku} ${r.qtyKg} kg`,
      );
    }
  }

  // 3. Specs sin color
  console.log('\n[3] Specs sin color');
  for (const s of specs.filter((x) => x.colorId === null)) {
    const kinds = plan.groupBySpec.get(s.id)?.map((k) => k.split('|')[1]) ?? ['?'];
    const lives = reservations.filter((r) => r.specId === s.id);
    console.log(
      `  ${lineName(s.businessLineId)} ${s.thicknessMm} mm → ${kinds.join(' + ')}${kinds.length > 1 ? '  ← SE PARTE' : ''} · reservas vivas ${lives.length}`,
    );
  }

  // 4. Agregado antes y después
  console.log('\n[4] Agregado antes → después (kg)');
  for (const g of plan.groups) {
    const beforeFree = g.availableBeforeKg;
    const a = g.after;
    const changed =
      g.sourceSpecIds.length > 1 ||
      !a.availableKg.equals(beforeFree) ||
      g.before.some((b) => b.coilCodes.join() !== a.coilCodes.join());
    if (!changed && a.reservedGenericKg.isZero()) continue;
    console.log(
      `  ${lineName(g.businessLineId)} ${g.materialKey.padEnd(12)} ${g.thicknessMm} · físico ${kg(a.physicalKg)} · prometido ${kg(a.reservedGenericKg)} · libre ${kg(beforeFree)} → ${kg(a.availableKg)}` +
        (a.availableKg.lt(0) ? '  ← EN FALTA' : ''),
    );
  }
  console.log(`  RESERVAS NUEVAS EN FALTA: ${plan.newShortfalls.length}`);
  for (const g of plan.newShortfalls) {
    console.log(
      `    ${g.key}: libre ${kg(g.after.availableKg)} · ${g.reservations.map((r) => r.documentCode).join(', ')}`,
    );
  }
  if (plan.anomalies.length > 0) {
    console.log('  ANOMALÍAS:');
    for (const a of plan.anomalies) console.log(`    [${a.kind}] ${a.detail}`);
  }

  // 5. OPs vivas
  console.log(
    `\n[5] OPs de coberturas vivas: ${mounted.liveRoofingOrders}; bobinas montadas sin liberar: ${mounted.rows.length}`,
  );
  for (const m of mounted.rows) {
    console.log(
      `  ${m.orderCode} ${m.productSku} ← ${m.coilCode} · antes ${m.matchesBefore ? 'coincide' : 'NO'} · después ${m.matchesAfter ? 'coincide' : 'NO  ← DEJA DE COINCIDIR'}`,
    );
  }

  // 6. Faltantes de cotizaciones emitidas (antes y después), con la misma cuenta por documento
  //    que `findStockShortages`: las líneas del mismo agregado compiten entre sí.
  console.log('\n[6] Faltantes de cotizaciones emitidas vigentes (antes → después)');
  const today = new Date().toISOString().slice(0, 10);
  const groupByKey = new Map(plan.groups.map((g) => [g.key, g]));
  const beforeBySpec = new Map(
    [...plan.beforeBySpec].map(([id, a]) => [id, a.availableKg] as const),
  );
  const shortageChanges: { quotation: string; before: string; after: string }[] = [];
  const byQuotation = new Map<string, typeof lines.quotationItems>();
  for (const i of lines.quotationItems) {
    if (i.quotation.status !== 'EMITTED') continue;
    const vu = i.quotation.validUntil?.toISOString().slice(0, 10) ?? null;
    if (vu !== null && vu < today) continue;
    byQuotation.set(i.quotation.id, [...(byQuotation.get(i.quotation.id) ?? []), i]);
  }
  for (const [qid, items] of byQuotation) {
    const own = reservations.filter((r) => r.temporary && r.documentId === qid);
    const takenBefore = new Map<string, Decimal>();
    const takenAfter = new Map<string, Decimal>();
    let missingBefore = new Decimal(0);
    let missingAfter = new Decimal(0);
    for (const i of items.sort((a, b) => a.lineNumber - b.lineNumber)) {
      const spec = specById.get(i.reserveItemId);
      const product = lines.productById.get(i.productId);
      if (!spec || !product) continue;
      const qty = toDecimal(i.reserveQty.toString());
      const ownBefore = sumQty(own.filter((r) => r.specId === spec.id));
      const availBefore = (beforeBySpec.get(spec.id) ?? new Decimal(0)).plus(ownBefore);
      const tb = takenBefore.get(spec.id) ?? new Decimal(0);
      missingBefore = missingBefore.plus(
        Decimal.max(qty.minus(Decimal.max(availBefore.minus(tb), new Decimal(0))), new Decimal(0)),
      );
      takenBefore.set(spec.id, tb.plus(qty));

      const mk = materialKeyOf(
        product.finish?.kind ?? 'PREPINTADO',
        product.colorId === null ? null : (colorById.get(product.colorId)?.commercialColor ?? null),
      );
      const gk = `${spec.businessLineId}|${mk ?? '?'}|${spec.thicknessMm}`;
      const group = groupByKey.get(gk);
      const ownAfter = sumQty(own.filter((r) => group?.reservations.some((x) => x.id === r.id)));
      const availAfter = (group?.after.availableKg ?? new Decimal(0)).plus(ownAfter);
      const ta = takenAfter.get(gk) ?? new Decimal(0);
      missingAfter = missingAfter.plus(
        Decimal.max(qty.minus(Decimal.max(availAfter.minus(ta), new Decimal(0))), new Decimal(0)),
      );
      takenAfter.set(gk, ta.plus(qty));
    }
    if (!missingBefore.equals(missingAfter)) {
      shortageChanges.push({
        quotation: quotationCode(items[0]?.quotation.seq ?? 0),
        before: kg(missingBefore),
        after: kg(missingAfter),
      });
    }
  }
  console.log(`  cotizaciones emitidas vigentes con materia prima: ${byQuotation.size}`);
  if (shortageChanges.length === 0) console.log('  ninguna cambia de faltante');
  for (const c of shortageChanges)
    console.log(`  ${c.quotation}: falta ${c.before} kg → ${c.after} kg`);

  // 7. Piso de precio de las líneas abiertas
  console.log(
    '\n[7] Piso de precio de líneas abiertas de materia prima (valor sin IGV por unidad de venta)',
  );
  interface FloorRow {
    document: string;
    line: number;
    sku: string;
    unitValuePen: string;
    oldCostPerKg: string;
    newCostPerKg: string;
    oldFloorPen: string;
    newFloorPen: string;
    deltaPen: string;
    oldCostPerUnitPen: string;
    floorBelowOldCost: boolean;
    priceBelowNewFloor: boolean;
    newCoils: string[];
  }
  const floorRows: FloorRow[] = [];
  const allLines = [
    ...lines.quotationItems.map((i) => ({ ...i, doc: quotationCode(i.quotation.seq) })),
    ...lines.orderItems.map((i) => ({ ...i, doc: salesOrderCode(i.salesOrder.seq) })),
  ];
  for (const i of allLines) {
    const product = lines.productById.get(i.productId);
    const spec = specById.get(i.reserveItemId);
    if (!product || !spec) continue;
    const margin = minMarginByLine.get(product.businessLineId);
    if (margin === undefined) continue;
    let kgPerUnit: Decimal;
    try {
      kgPerUnit = theoreticalKgForMeters(product, orderedMeters(product, '1'), i.doc);
    } catch {
      continue;
    }
    const mk = materialKeyOf(
      product.finish?.kind ?? 'PREPINTADO',
      product.colorId === null ? null : (colorById.get(product.colorId)?.commercialColor ?? null),
    );
    const { before, after } = floorCoils(
      coils,
      { businessLineId: spec.businessLineId, thicknessMm: spec.thicknessMm, colorId: spec.colorId },
      mk,
      toleranceMm,
    );
    const oldCost = weightedCostPerKg(before);
    const newCost = weightedCostPerKg(after);
    if (oldCost.equals(newCost)) continue;
    const floorOf = (cost: Decimal): Decimal =>
      cost.lte(0)
        ? new Decimal(0)
        : toDecimal(minAllowedValue(cost.times(kgPerUnit).toFixed(4), margin));
    const oldFloor = floorOf(oldCost);
    const newFloor = floorOf(newCost);
    const oldCostPerUnit = oldCost.times(kgPerUnit);
    floorRows.push({
      document: i.doc,
      line: i.lineNumber,
      sku: product.sku,
      unitValuePen: i.unitPricePen.toFixed(4),
      oldCostPerKg: oldCost.toFixed(4),
      newCostPerKg: newCost.toFixed(4),
      oldFloorPen: oldFloor.toFixed(4),
      newFloorPen: newFloor.toFixed(4),
      deltaPen: newFloor.minus(oldFloor).toFixed(4),
      oldCostPerUnitPen: oldCostPerUnit.toFixed(4),
      floorBelowOldCost: newFloor.gt(0) && newFloor.lt(oldCostPerUnit),
      priceBelowNewFloor: toDecimal(i.unitPricePen.toString()).lt(newFloor),
      newCoils: after
        .filter((c) => !before.includes(c))
        .map((c) => `${c.code} (RAL ${c.ralCode ?? '-'})`),
    });
  }
  console.log(
    `  líneas abiertas de MP: ${allLines.length}; con piso que se mueve: ${floorRows.length}`,
  );
  for (const r of floorRows) {
    console.log(
      `  ${r.document} L${r.line} ${r.sku} · valor ${r.unitValuePen} · costo/kg ${r.oldCostPerKg} → ${r.newCostPerKg} · piso ${r.oldFloorPen} → ${r.newFloorPen} (Δ ${r.deltaPen})` +
        (r.floorBelowOldCost ? '  ← PISO BAJO EL COSTO VIEJO' : '') +
        (r.priceBelowNewFloor ? '  ← PRECIO BAJO EL PISO NUEVO' : ''),
    );
    if (r.newCoils.length > 0) console.log(`      entran: ${r.newCoils.join(', ')}`);
  }

  // 8. Inventario valorizado
  console.log('\n[8] Inventario valorizado de bobinas');
  console.log(
    `  filas ${valuation.rows} · grupos hoy ${valuation.groupsToday} → por color comercial ${valuation.groupsAfter} · total hoy ${valuation.totalTodayPen} · total nuevo ${valuation.totalAfterPen}`,
  );

  const stop =
    plan.newShortfalls.length > 0 ||
    plan.anomalies.length > 0 ||
    colors.some((c) => c.mismatch || c.empty) ||
    mounted.rows.some((m) => m.matchesBefore && !m.matchesAfter) ||
    floorRows.some((r) => r.floorBelowOldCost) ||
    hypothesis.some(
      (h) =>
        h.kindCollision ||
        (h.colors.length > 1 && (h.mixedDensity || h.suspiciousNames.length > 0)),
    );
  console.log(
    `\n=== ${stop ? 'HAY CONDICIONES DE PARADA (ver marcas ←)' : 'Sin condiciones de parada'} ===`,
  );

  const outDir = resolve(__dirname, '../../../local-data/color-comercial');
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(
    outDir,
    `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        branch: label,
        toleranceMm,
        colors,
        hypothesis,
        merges: plan.merges,
        splits: plan.splits,
        groups: plan.groups,
        newShortfalls: plan.newShortfalls,
        anomalies: plan.anomalies,
        mounted,
        shortageChanges,
        floorRows,
        valuation,
        stop,
      },
      (_k, v: unknown) => (v instanceof Decimal ? v.toFixed(4) : v),
      2,
    ),
  );
  console.log(`Salida completa: ${outFile}`);
}

function sumQty(rows: { qtyKg: string }[]): Decimal {
  return rows.reduce((acc, r) => acc.plus(toDecimal(r.qtyKg)), new Decimal(0));
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
