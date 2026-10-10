import { Test, type TestingModule } from '@nestjs/testing';
import type { Response } from 'express';
import * as XLSX from 'xlsx';
import {
  BUSINESS_LINE_LABELS,
  businessToday,
  COIL_REPORT_LINES,
  Decimal,
  INVENTORY_VALUATION_LINES,
  SALES_BY_MATERIAL_LINES,
  SALES_MARGIN_LINES,
  coilWasteRowSearchText,
  filterBySearch,
  groupSalesMargin,
  inventoryProductSearchText,
  receivablesCustomerSearchText,
  salesMarginSearchText,
  summarizeSalesMargin,
  toDecimal,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import { ReportsController } from './reports.controller';

/**
 * cc39 (D-580) — **el Excel dice lo mismo que la pantalla, con el mismo filtro**, contra una base
 * real. Para cada reporte y cada pestaña se pide la ruta JSON (lo que pinta la pantalla) y la ruta
 * del Excel con la misma consulta, por el controlador, y se comparan los totales de la hoja con
 * los del JSON —los que la pantalla muestra en su franja y al pie sin búsqueda— y, donde la
 * columna suma, que las filas de la hoja den ese total.
 *
 * Así se prueban juntas las dos cosas que podían fallar: que la ruta del Excel respete el filtro
 * de la pantalla (antes descartaba la línea, D-396) y que la hoja no pierda ni duplique filas.
 * Corre en `pnpm --filter @ayr/api test:db` (base de pruebas recién reseteada y sembrada).
 */
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
process.env.JOBS_ENABLED = 'false';
jest.setTimeout(5 * 60_000);

const FROM = '2026-01-01';

let moduleRef: TestingModule;
let controller: ReportsController;

beforeAll(async () => {
  assertTestDatabase();
  moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await moduleRef.init();
  controller = moduleRef.get(ReportsController);
});

afterAll(async () => {
  await moduleRef?.close();
});

type Cell = string | number | null | undefined;

/** Pide el Excel por su ruta y devuelve las hojas como filas de celdas, y el nombre del archivo. */
async function download(
  call: (res: Response) => Promise<void>,
): Promise<{ filename: string; sheet: (name: string) => Cell[][] }> {
  const res = {
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
  };
  await call(res as unknown as Response);
  const book = XLSX.read(res.body, { type: 'buffer' });
  const filename = /filename="([^"]+)"/.exec(res.headers['Content-Disposition'] ?? '')?.[1] ?? '';
  return {
    filename,
    sheet: (name) => {
      const grid = book.Sheets[name];
      if (grid === undefined) throw new Error(`El Excel no tiene la hoja «${name}»`);
      return XLSX.utils.sheet_to_json<Cell[]>(grid, { header: 1, defval: null });
    },
  };
}

/** La celda numérica como `Decimal` (vacía = `null`). */
function dec(cell: Cell): Decimal | null {
  return typeof cell === 'number' ? toDecimal(String(cell)) : null;
}

/** La celda tiene el mismo valor que la cifra del JSON (las dos vacías, o el mismo número). */
function expectSame(cell: Cell, value: string | null, what: string): void {
  if (value === null) {
    expect({ what, cell: cell ?? null }).toEqual({ what, cell: null });
    return;
  }
  const got = dec(cell);
  expect({ what, got: got?.toString() ?? null }).toEqual({
    what,
    got: toDecimal(value).toString(),
  });
}

/** La fila cuyo primer texto empieza con `label`. */
function rowStarting(rows: Cell[][], label: string): Cell[] {
  const row = rows.find((r) => typeof r[0] === 'string' && r[0].startsWith(label));
  if (row === undefined) throw new Error(`No está la fila «${label}»`);
  return row;
}

/** Suma de una columna entre dos filas (sin la cabecera), como Decimal. */
function columnSum(rows: Cell[][], col: number, from: number, to: number): Decimal {
  return rows
    .slice(from, to)
    .reduce((acc, r) => acc.plus(dec(r[col]) ?? new Decimal(0)), new Decimal(0));
}

const range = (): { from: string; to: string } => ({ from: FROM, to: businessToday() });

describe('Merma por bobina: el Excel de cada pestaña es la pantalla', () => {
  it.each(COIL_REPORT_LINES)('%s', async (businessLine) => {
    const query = { ...range(), businessLine };
    const screen = await controller.coilWasteReport(query);
    const xlsx = await download((res) => controller.coilWasteXlsxFile(query, {}, res));
    expect(xlsx.filename).toContain(businessLine);

    const rows = xlsx.sheet('Merma por bobina');
    const header = rows[0] ?? [];
    const col = (name: string) => header.indexOf(name);
    // Una fila por bobina de la pantalla, en el mismo orden.
    expect(rows.slice(1, 1 + screen.rows.length).map((r) => r[0])).toEqual(
      screen.rows.map((r) => r.code),
    );
    const total = rowStarting(rows, 'Total ·');
    const t = screen.totals;
    expectSame(total[col('Consumido (kg)')], t.consumedKg, 'consumido');
    expectSame(total[col('Teórico (kg)')], t.theoreticalKg, 'teórico');
    expectSame(total[col('Diferencia (kg)')], t.differenceKg, 'diferencia');
    expectSame(total[col('Ajuste de cierre (kg)')], t.closeAdjustmentKg, 'ajuste');
    expectSame(total[col('Merma (kg)')], t.wasteKg, 'merma');
    expectSame(total[col('Merma %')], t.wastePct, 'merma %');
    expectSame(total[col('Otra merma (kg)')], t.manualScrapKg, 'otra merma');
    expectSame(total[9], t.trimKg, 'despunte / merma de proceso');
    // El consumo de todas las bobinas suma el total (a lo sumo 0,001 kg de redondeo por fila).
    const consumed = columnSum(rows, col('Consumido (kg)'), 1, 1 + screen.rows.length);
    expect(
      consumed
        .minus(toDecimal(t.consumedKg))
        .abs()
        .lte(toDecimal('0.001').times(screen.rows.length)),
    ).toBe(true);
    // Las producciones del detalle, todas.
    const productions = xlsx.sheet('Producciones');
    expect(productions.length - 1).toBe(screen.rows.reduce((n, r) => n + r.productions.length, 0));
  });
});

describe('Ventas por material: el Excel de cada pestaña, con sus filtros, es la pantalla', () => {
  it.each(SALES_BY_MATERIAL_LINES)('%s', async (businessLine) => {
    const query = { ...range(), businessLine };
    const screen = await controller.salesByMaterialReport(query);
    const xlsx = await download((res) => controller.salesByMaterialXlsxFile(query, {}, res));
    expect(screen.businessLine).toBe(businessLine);

    if (screen.products === null) {
      const rows = xlsx.sheet('Ventas por material');
      const header = rows[0] ?? [];
      const total = rowStarting(rows, 'Total');
      const col = (name: string) => header.indexOf(name);
      expectSame(total[col('ML vendido')], screen.total.metersSold, 'ML');
      expectSame(total[col('Peso real (kg)')], screen.total.realKg, 'peso real');
      expectSame(total[col('Venta sin IGV (S/)')], screen.total.salesPen, 'venta');
      expectSame(total[col('Costo de producción (S/)')], screen.total.costPen, 'costo');
      expectSame(total[col('Utilidad (S/)')], screen.total.profitPen, 'utilidad');
      expect(xlsx.sheet('No trazable').length - 1).toBe(screen.untraceable.length);
    } else {
      const rows = xlsx.sheet('Ventas por producto');
      const header = rows[0] ?? [];
      const col = (name: string) => header.indexOf(name);
      const n = screen.products.rows.length;
      expect(rows.slice(1, 1 + n).map((r) => r[0])).toEqual(screen.products.rows.map((r) => r.sku));
      const total = rowStarting(rows, 'Total');
      expectSame(total[col('Venta sin IGV (S/)')], screen.products.total.salesPen, 'venta');
      expectSame(total[col('Costo (S/)')], screen.products.total.costPen, 'costo');
      expectSame(total[col('Utilidad (S/)')], screen.products.total.profitPen, 'utilidad');
      // Las filas de producto suman el total al céntimo.
      expect(
        columnSum(rows, col('Venta sin IGV (S/)'), 1, 1 + n)
          .minus(toDecimal(screen.products.total.salesPen))
          .abs()
          .lte(toDecimal('0.0001').times(n)),
      ).toBe(true);
      expect(xlsx.sheet('No trazable').length - 1).toBe(screen.products.untraceable.length);
    }
    expectSame(
      rowStarting(
        xlsx.sheet(screen.products === null ? 'Ventas por material' : 'Ventas por producto'),
        'Venta no trazable',
      )[1],
      screen.untraceableSalesPen,
      'no trazable',
    );
  });
});

describe('Inventario valorizado: el Excel de cada pestaña es la pantalla', () => {
  it.each([undefined, ...INVENTORY_VALUATION_LINES])('%s', async (businessLine) => {
    const query = businessLine === undefined ? {} : { businessLine };
    const screen = await controller.inventoryValuationReport(query);
    const xlsx = await download((res) => controller.inventoryValuationXlsxFile(query, {}, res));
    if (businessLine !== undefined) expect(xlsx.filename).toContain(businessLine);

    const total = rowStarting(
      xlsx.sheet('Totales'),
      businessLine === undefined ? 'Total general' : `Total ${BUSINESS_LINE_LABELS[businessLine]}`,
    );
    expectSame(total[1], screen.totals.coilValuePen, 'bobinas');
    expectSame(total[2], screen.totals.productValuePen, 'productos');
    expectSame(total[3], screen.totals.totalValuePen, 'total');
    // Las bobinas y los productos de la hoja son los de la pestaña, y suman su valor.
    const coils = xlsx.sheet('Bobinas');
    const coilCount = screen.coilGroups.reduce((n, g) => n + g.coils.length, 0);
    expect(coils.length - 1).toBe(coilCount);
    const products = xlsx.sheet('Productos');
    expect(products.length - 1).toBe(screen.products.length);
    expect(
      columnSum(products, 6, 1, products.length)
        .minus(toDecimal(screen.totals.productValuePen))
        .abs()
        .lte(toDecimal('0.01').times(Math.max(1, screen.products.length))),
    ).toBe(true);
  });
});

describe('Ventas y margen: el Excel de cada pestaña es la pantalla', () => {
  it.each([undefined, ...SALES_MARGIN_LINES])('%s', async (businessLine) => {
    const query = { ...range(), ...(businessLine === undefined ? {} : { businessLine }) };
    const screen = await controller.salesMarginReport(query);
    const xlsx = await download((res) => controller.salesMarginXlsxFile(query, {}, res));
    if (businessLine !== undefined) expect(xlsx.filename).toContain(businessLine);

    const totals = xlsx.sheet('Totales');
    const total =
      businessLine === undefined
        ? rowStarting(totals, 'Total del rango')
        : rowStarting(totals, `Total ${BUSINESS_LINE_LABELS[businessLine]}`);
    const t = screen.totals;
    expectSame(total[1], t.salesPen, 'venta');
    if (businessLine === 'services') {
      // D-392: Servicios no tiene costo registrado; la pantalla no muestra costo ni margen.
      expect(total.slice(2, 5).every((c) => c === null)).toBe(true);
    } else {
      expectSame(total[2], t.costPen, 'costo');
      expectSame(total[3], t.marginPen, 'margen');
      expectSame(total[4], t.marginPct, 'margen %');
    }
    // Los pedidos de la hoja son los que suman en la pantalla, y los de facturación parcial, aparte.
    expect(orderRows(xlsx.sheet('Por pedido'))).toHaveLength(
      screen.orders.filter((o) => o.inTotals).length,
    );
    expect(orderRows(xlsx.sheet('Facturación parcial'))).toHaveLength(
      screen.orders.filter((o) => !o.inTotals).length,
    );
  });
});

/** Las filas de pedido de una hoja de «Ventas y margen»: sin cabecera, total ni notas. */
function orderRows(rows: Cell[][]): Cell[][] {
  return rows.filter(
    (r, i) =>
      i > 0 &&
      typeof r[0] === 'string' &&
      r[0] !== '' &&
      !r[0].startsWith('Total') &&
      !r[0].startsWith('Búsqueda'),
  );
}

/**
 * cc40 (D-587): «Por pedido» suma cada venta una vez. El total de la hoja es el pie de la tabla de
 * la pantalla (`summarizeSalesMargin` de los pedidos que suman), es la suma de su columna de venta,
 * es la suma de los comprobantes, y es el total de «Ver por» Vendedor y Cliente: las tres vistas,
 * con el mismo filtro, dan lo mismo.
 */
describe('Ventas y margen: «Por pedido» cuadra con las otras vistas y con sus comprobantes', () => {
  it.each([undefined, ...SALES_MARGIN_LINES])('%s', async (businessLine) => {
    const query = { ...range(), ...(businessLine === undefined ? {} : { businessLine }) };
    const screen = await controller.salesMarginReport(query);
    const included = screen.orders.filter((o) => o.inTotals);
    const xlsx = await download((res) => controller.salesMarginXlsxFile(query, {}, res));
    const rows = xlsx.sheet('Por pedido');
    const header = rows[0] ?? [];
    const sales = header.indexOf('Venta sin IGV (S/)');
    const pie = summarizeSalesMargin(included);
    const total = rowStarting(rows, 'Total ·');
    expectSame(total[sales], pie.sales.toFixed(), 'venta del pie');
    // La columna de venta suma una vez: las filas de pedido dan el total, sin los comprobantes.
    const summed = orderRows(rows).reduce(
      (acc, r) => acc.plus(dec(r[sales]) ?? new Decimal(0)),
      new Decimal(0),
    );
    expect(summed.minus(pie.sales).abs().lte(toDecimal('0.0001').times(included.length))).toBe(
      true,
    );
    if (businessLine !== 'services') {
      expectSame(total[header.indexOf('Costo (S/)')], pie.cost.toFixed(), 'costo del pie');
      expectSame(total[header.indexOf('Margen (S/)')], pie.margin.toFixed(), 'margen del pie');
      expectSame(total[header.indexOf('Margen %')], pie.marginPct, 'margen % del pie');
    }
    // «Ver por» Vendedor y Cliente: la suma de los grupos es el mismo total.
    for (const by of ['vendedor', 'cliente'] as const) {
      const groups = groupSalesMargin(included, by);
      const groupSales = groups.reduce((acc, g) => acc.plus(g.sales), new Decimal(0));
      expect({ by, sales: groupSales.toFixed() }).toEqual({ by, sales: pie.sales.toFixed() });
      expect(groups.reduce((n, g) => n + g.count, 0)).toBe(included.length);
    }
    // Los comprobantes de «Por pedido», en su hoja, suman la misma venta.
    const documents = xlsx.sheet('Comprobantes');
    const docTotal = rowStarting(documents, 'Total ·');
    expect(String(docTotal[0])).toContain('«Por pedido»');
    expectSame(
      docTotal[(documents[0] ?? []).indexOf('Venta sin IGV (S/)')],
      pie.sales.toFixed(),
      'venta de los comprobantes',
    );
  });
});

/**
 * cc40 (D-588): con la búsqueda de la pantalla, el Excel trae las mismas filas que la pantalla
 * filtra (el mismo texto buscable de `@ayr/shared`) y su total es el del pie con la búsqueda.
 * La búsqueda sale de los datos: la primera palabra del primer cliente, bobina o producto.
 */
describe('La búsqueda de la pantalla viaja al Excel', () => {
  const firstWord = (text: string | undefined): string | null =>
    text?.split(/\s+/).find((w) => w.length >= 3) ?? null;

  it('Ventas y margen: los pedidos que coinciden y el total del pie', async () => {
    const query = range();
    const screen = await controller.salesMarginReport(query);
    const included = screen.orders.filter((o) => o.inTotals);
    const search = firstWord(included[0]?.customerName);
    if (search === null) return;
    const shown = filterBySearch(included, salesMarginSearchText, search);
    const xlsx = await download((res) => controller.salesMarginXlsxFile(query, { search }, res));
    const rows = xlsx.sheet('Por pedido');
    expect(orderRows(rows).map((r) => r[0])).toEqual(shown.map((o) => o.orderCode ?? 'Sin pedido'));
    expectSame(
      rowStarting(rows, 'Total ·')[(rows[0] ?? []).indexOf('Venta sin IGV (S/)')],
      summarizeSalesMargin(shown).sales.toFixed(),
      'venta con búsqueda',
    );
    rowStarting(rows, `Búsqueda «${search}»`);
  });

  it.each(COIL_REPORT_LINES)('Merma por bobina (%s): las bobinas que coinciden', async (line) => {
    const query = { ...range(), businessLine: line };
    const screen = await controller.coilWasteReport(query);
    const search = screen.rows[0]?.code;
    if (search === undefined) return;
    const shown = filterBySearch(screen.rows, coilWasteRowSearchText, search);
    const xlsx = await download((res) => controller.coilWasteXlsxFile(query, { search }, res));
    const rows = xlsx.sheet('Merma por bobina');
    expect(rows.slice(1, 1 + shown.length).map((r) => r[0])).toEqual(shown.map((r) => r.code));
    expect(rowStarting(rows, 'Total ·')[0]).toBe(
      `Total · ${String(shown.length)} ${shown.length === 1 ? 'bobina' : 'bobinas'}`,
    );
  });

  it('Inventario valorizado: los productos que coinciden', async () => {
    const screen = await controller.inventoryValuationReport({});
    const search = screen.products[0]?.sku;
    if (search === undefined) return;
    const shown = filterBySearch(screen.products, inventoryProductSearchText, search);
    const xlsx = await download((res) =>
      controller.inventoryValuationXlsxFile({}, { search }, res),
    );
    const products = xlsx.sheet('Productos').filter((r, i) => i > 0 && r[1] !== null);
    expect(products.map((r) => r[0])).toEqual(shown.map((p) => p.sku));
  });

  it('Cuentas por cobrar: los clientes que coinciden y su saldo', async () => {
    const screen = await controller.receivablesAgingReport({});
    const search = firstWord(screen.customers[0]?.customerName);
    if (search === null) return;
    const shown = filterBySearch(screen.customers, receivablesCustomerSearchText, search);
    const xlsx = await download((res) => controller.receivablesAgingXlsxFile({}, { search }, res));
    const rows = xlsx.sheet('Por cliente');
    expect(rows.slice(1, 1 + shown.length).map((r) => r[0])).toEqual(
      shown.map((c) => c.customerName),
    );
    const balance = shown.reduce((acc, c) => acc.plus(c.balancePen), new Decimal(0));
    expectSame(
      rowStarting(rows, 'Total al')[(rows[0] ?? []).length - 1],
      balance.toFixed(),
      'saldo',
    );
  });
});
