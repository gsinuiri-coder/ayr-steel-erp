/* eslint-disable no-console -- guion de diagnostico: su salida ES la consola. */
/**
 * Diagnóstico de **solo lectura**: qué SKU activos tienen su precio de lista por debajo del
 * piso duro de D-163.
 *
 * Para qué. El piso quedó exento en el mostrador (D-163) porque el carrito de caja no tiene
 * dónde mostrar el mínimo y el rechazo tira abajo la transacción entera de D-099, con el
 * cliente delante. Poner el aviso en el POS es una decisión del dueño, y esa decisión
 * necesita el número que falta: **cuántos SKU quedarían avisando**. D-163 subió los mínimos
 * respecto de D-032 —el margen pasó de markup sobre el costo a margen sobre la venta—, así
 * que la respuesta de antes ya no sirve.
 *
 * Qué compara. Valor contra valor y no precio contra precio, exactamente como
 * `assertPriceFloor`: `products.list_price_pen` es el **valor de venta sin IGV** (D-068,
 * D-162) y el piso es `minAllowedValue` = `costo promedio ÷ (1 − margen mínimo)`. Comparar
 * los precios con IGV metería dos redondeos por 1.18 en una cuenta que se decide en la
 * cuarta decimal. Los precios con IGV se muestran igual, porque son los que el dueño lee.
 *
 * Qué NO hace. No escribe nada, no toca el POS y no propone precios nuevos. Los SKU sin
 * costo en el kardex no aparecen como infractores: sin costo no hay piso (D-163), y listarlos
 * como "por debajo de S/ 0.00" sería ruido. Se cuentan aparte para que el total cierre.
 *
 * Uso: `node scripts/check-price-floor.mjs [--branch production|demo|dev|local]`.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Decimal, salePriceFromValue, toDecimal, type BusinessLine } from '@ayr/shared';
import { toSharedLineCode } from '../src/common/business-line-code';
import { computePriceFloorOutcomes, type PriceFloorCost } from '../src/sales/price-floor';
import { FLOOR_COST_SELECT, productFloorCost } from '../src/sales/price-floor-cost';

const prisma = new PrismaClient();

interface Row {
  sku: string;
  name: string;
  businessLine: BusinessLine;
  /** Valor de lista sin IGV, tal como está en el maestro. */
  listValuePen: Decimal;
  /** Costo del piso en la unidad de venta (kardex; flejes en un perfil sin saldo, D-713). */
  costPen: Decimal;
  /** Piso en valor sin IGV: `costo ÷ (1 − margen mínimo)`. */
  minValuePen: Decimal;
  minMarginPct: Decimal;
}

async function main(): Promise<void> {
  const label = process.env.AYR_BRANCH_LABEL ?? 'la rama configurada';

  const settings = await prisma.pricingSetting.findMany({
    select: { businessLineId: true, minMarginPct: true },
  });
  const minMarginByLine = new Map(
    settings.map((s) => [s.businessLineId, s.minMarginPct.toFixed(4)]),
  );

  const products = await prisma.product.findMany({
    where: { isActive: true, listPricePen: { not: null } },
    select: {
      sku: true,
      name: true,
      unit: true,
      listPricePen: true,
      ...FLOOR_COST_SELECT,
    },
    orderBy: { sku: 'asc' },
  });

  const below: Row[] = [];
  let sinCosto = 0;
  let sinMargen = 0;
  let sobreElPiso = 0;

  // D-713 (dw-03): el costo de cada SKU sale de `productFloorCost` + `computePriceFloorOutcomes`,
  // las mismas funciones que aplican el piso al vender: un perfil de drywall con saldo usa su
  // kardex y uno sin saldo, sus flejes compatibles. Antes este guion leía el saldo a secas.
  const priced: { product: (typeof products)[number]; cost: PriceFloorCost }[] = [];
  for (const p of products) {
    const minMarginPct = minMarginByLine.get(p.businessLineId);
    // Sin fila en `pricing_settings` no hay margen que aplicar y el API deja pasar la línea
    // (`computePriceFloors` hace lo mismo): se cuenta aparte, no se inventa un margen.
    if (minMarginPct === undefined || toDecimal(minMarginPct).gte(100)) {
      sinMargen += 1;
      continue;
    }
    const floorCost = productFloorCost(p);
    // Un perfil al que le falta espesor, ancho o peso en el SKU no tiene piso (D-342/D-344).
    if (!('cost' in floorCost)) {
      sinCosto += 1;
      continue;
    }
    priced.push({ product: p, cost: floorCost.cost });
  }
  // Una sola tanda de costos, no una consulta por SKU: el catálogo real pasa el millar. La
  // tolerancia solo la usa el costo por bobina de una cobertura a medida, que aquí no entra.
  const outcomes = await computePriceFloorOutcomes(
    prisma,
    priced.map(({ product, cost }) => ({
      at: product.id,
      sku: product.sku,
      businessLineId: product.businessLineId,
      basis: { kind: 'UNIT' as const, unitLabel: product.unit },
      unitValuePen: '0',
      cost,
    })),
    '0',
  );

  for (const { product: p } of priced) {
    const outcome = outcomes.get(p.id);
    if (outcome === undefined || !('minValuePen' in outcome)) {
      sinCosto += 1;
      continue;
    }
    const costPen = toDecimal(outcome.costPen);
    const minMarginPct = outcome.minMarginPct;
    const listValuePen = toDecimal(p.listPricePen?.toString() ?? '0');
    const minValuePen = toDecimal(outcome.minValuePen);
    if (listValuePen.gte(minValuePen)) {
      sobreElPiso += 1;
      continue;
    }
    below.push({
      sku: p.sku,
      name: p.name,
      businessLine: toSharedLineCode(p.businessLine.code),
      listValuePen,
      costPen,
      minValuePen,
      minMarginPct: toDecimal(minMarginPct),
    });
  }

  // Lo más lejos del piso primero: es el orden en el que conviene mirarlos.
  below.sort((a, b) => gapPct(a).comparedTo(gapPct(b)));

  console.log(`SKU activos con precio de lista en ${label}: ${products.length}`);
  console.log(`  por encima del piso de D-163 ....... ${sobreElPiso}`);
  console.log(`  sin costo (sin piso) .............. ${sinCosto}`);
  if (sinMargen > 0) {
    console.log(`  sin margen mínimo configurado ...... ${sinMargen}`);
  }
  console.log(`  POR DEBAJO DEL PISO ................ ${below.length}`);
  console.log('');

  if (below.length === 0) {
    console.log('Ningún SKU activo queda por debajo del mínimo. Un aviso en el POS no');
    console.log('alcanzaría a ninguna venta con el precio de lista de hoy.');
    return;
  }

  const columns: [string, (r: Row) => string][] = [
    ['SKU', (r) => r.sku],
    ['Nombre', (r) => (r.name.length > 34 ? `${r.name.slice(0, 33)}…` : r.name)],
    ['Línea', (r) => r.businessLine],
    ['Costo', (r) => r.costPen.toFixed(2)],
    ['P. lista', (r) => salePriceFromValue(r.listValuePen).toFixed(2)],
    ['Mínimo', (r) => salePriceFromValue(r.minValuePen).toFixed(2)],
    ['Dif. %', (r) => `${gapPct(r).toFixed(1)}%`],
  ];
  // Los precios se imprimen CON IGV (D-162): es como el dueño los lee en el POS y en la
  // lista. La comparación de arriba ya se hizo en valores, que es donde vive el piso.
  console.log('Precios CON IGV. «Dif. %» es cuánto le falta al precio de lista para llegar');
  console.log('al mínimo, sobre el mínimo. Margen mínimo por línea entre paréntesis.');
  console.log('');
  printTable(columns, below);
  console.log('');
  console.log('Margen mínimo aplicado por línea:');
  for (const line of [...new Set(below.map((r) => r.businessLine))]) {
    const pct = below.find((r) => r.businessLine === line)?.minMarginPct;
    console.log(`  ${line}: ${pct?.toFixed(2) ?? '—'}%`);
  }
}

/** Cuánto le falta al precio de lista para llegar al mínimo, en % **sobre el mínimo**. */
function gapPct(row: Row): Decimal {
  if (row.minValuePen.lte(0)) return new Decimal(0);
  return row.listValuePen.minus(row.minValuePen).div(row.minValuePen).times(100);
}

/** Tabla de ancho fijo por columna. Sin dependencias: la salida se lee en una terminal. */
function printTable(columns: [string, (r: Row) => string][], rows: Row[]): void {
  const widths = columns.map(([header, cell]) =>
    Math.max(header.length, ...rows.map((r) => cell(r).length)),
  );
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join('  ');
  console.log(line(columns.map(([header]) => header)));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(line(columns.map(([, cell]) => cell(row))));
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
