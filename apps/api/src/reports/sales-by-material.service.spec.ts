import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import {
  Decimal,
  kgPerMeter,
  salesByMaterialQuerySchema,
  type SalesByMaterialQuery,
} from '@ayr/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SalesByMaterialService } from './sales-by-material.service';

/**
 * D-354. Lo que se fija acá es el **criterio** del reporte: el prorrateo de la producción de una
 * línea entre sus comprobantes, la bobina entera, lo que va a «No trazable» y el presupuesto
 * de consultas. Las cuatro consultas se simulan por el texto del SQL, no por el orden.
 */

const d = (v: string): Prisma.Decimal => new Prisma.Decimal(v);
const SEPT: SalesByMaterialQuery = { from: '2026-09-01', to: '2026-09-30' };
const OCT: SalesByMaterialQuery = { from: '2026-10-01', to: '2026-10-31' };

interface LineSeed {
  doc?: string;
  issueDate?: string;
  docType?: 'FACTURA' | 'NOTA_CREDITO';
  item?: string | null;
  kind?: 'A_MEDIDA' | 'ACCESORIO' | 'PLANCHA' | null;
  coilSale?: boolean;
  qty: string;
  subtotal: string;
  lengthMm?: string;
  /** Unidad de venta; por defecto la del subtipo (MTR, o NIU en una plancha). */
  unit?: 'MTR' | 'NIU' | 'KGM';
  thickness?: string;
  color?: string | null;
  /** cc24: un producto de Drywall, fabricado (perfil) o comprado, con sus kilos por pieza. */
  drywall?: { source: 'MANUFACTURED' | 'PURCHASED'; pieceWeightKg?: string };
}

interface Seeds {
  lines: LineSeed[];
  /** D-407: la venta del rango sin producto. */
  noLine?: string | null;
  /** cc24 (D-417): filas crudas de las pestañas por producto. */
  productLines?: Record<string, unknown>[];
  declared?: Record<string, unknown>[];
  invoiced?: Record<string, string>;
  facts?: Record<string, { produced: string; orders?: number; dispatched?: string }>;
  usage?: {
    item: string;
    coil: string;
    kg: string;
    cost: string;
    thickness?: string;
    /** Metros que los reportes vigentes rolaron de esa bobina (D-369); por defecto ninguno. */
    meters?: string;
    width?: string;
    avgCost?: string | null;
  }[];
}

function lineRow(s: LineSeed): Record<string, unknown> {
  const nc = s.docType === 'NOTA_CREDITO';
  const coil = s.coilSale === true;
  const dw = s.drywall;
  if (dw !== undefined) {
    // Perfil de Drywall: NIU con largo, sin acabado ni color, espesor del fleje (D-344).
    return {
      ...lineRow({ ...s, drywall: undefined, kind: null, unit: 'NIU' }),
      sku: 'PARANTE-64',
      product_line: 'drywall',
      source: dw.source,
      piece_weight_kg: dw.pieceWeightKg === undefined ? d('1.500') : d(dw.pieceWeightKg),
      roofing_kind: null,
      length_mm: d(s.lengthMm ?? '3000'),
      p_width: d('120.00'),
      p_thickness: d(s.thickness ?? '0.45'),
      p_density: null,
      p_finish_kind: null,
      p_color: null,
    };
  }
  return {
    product_line: coil ? 'trading' : 'metallic-roofing',
    source: coil ? 'PURCHASED' : 'MANUFACTURED',
    piece_weight_kg: null,
    document_id: `00000000-0000-0000-0000-${(s.doc ?? '1').padStart(12, '0')}`,
    number: `F001-${s.doc ?? '1'}`,
    doc_type: s.docType ?? 'FACTURA',
    issue_date: new Date(`${s.issueDate ?? '2026-09-10'}T00:00:00.000Z`),
    order_seq: 7,
    sales_order_item_id: s.item === undefined ? 'soi-1' : s.item,
    qty: nc ? d(s.qty).negated() : d(s.qty),
    subtotal_pen: nc ? d(s.subtotal).negated() : d(s.subtotal),
    sku: coil ? 'BOBALZROJ030' : 'COB030ROJO',
    unit: s.unit ?? (coil ? 'KGM' : s.kind === 'PLANCHA' ? 'NIU' : 'MTR'),
    is_coil_sale: coil,
    roofing_kind: coil ? null : s.kind === undefined ? 'A_MEDIDA' : s.kind,
    length_mm: s.lengthMm === undefined ? null : d(s.lengthMm),
    p_width: coil ? null : d('1000.00'),
    p_thickness: coil ? null : d(s.thickness ?? '0.30'),
    p_density: coil ? null : d('7.8500'),
    p_finish_kind: coil ? null : 'PREPINTADO',
    p_color: coil ? null : s.color === undefined ? 'ROJO' : s.color,
    c_width: coil ? d('1000.00') : null,
    c_thickness: coil ? d('0.30') : null,
    c_density: coil ? d('7.8500') : null,
    c_finish_kind: coil ? 'PREPINTADO' : null,
    c_color: coil ? 'ROJO' : null,
    customer_name: 'CLIENTE SAC',
  };
}

async function build(seeds: Seeds): Promise<{ service: SalesByMaterialService; calls: string[] }> {
  const calls: string[] = [];
  const queryRaw = jest.fn((strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    calls.push(sql);
    // cc24 (D-417): las dos lecturas de las pestañas por producto.
    if (sql.includes('"shown_elsewhere"')) {
      return Promise.resolve(seeds.productLines ?? []);
    }
    if (sql.includes('WITH qty AS')) {
      return Promise.resolve(seeds.declared ?? []);
    }
    if (sql.includes('WITH ops AS')) {
      return Promise.resolve(
        (seeds.usage ?? []).map((u) => ({
          sales_order_item_id: u.item,
          coil_id: `coil-${u.coil}`,
          code: u.coil,
          type_key: 'PREP-0.30',
          thickness_mm: d(u.thickness ?? '0.30'),
          width_mm: d(u.width ?? '1000.00'),
          density_factor: d('7.8500'),
          finish_kind: 'PREPINTADO',
          color_name: 'ROJO',
          kg: d(u.kg),
          cost_pen: d(u.cost),
          meters: u.meters === undefined ? null : d(u.meters),
          avg_cost:
            u.avgCost === undefined ? d('2.5000') : u.avgCost === null ? null : d(u.avgCost),
        })),
      );
    }
    if (sql.includes('AS "order_count"')) {
      return Promise.resolve(
        Object.entries(seeds.facts ?? {}).map(([id, f]) => ({
          id,
          produced: d(f.produced),
          order_count: BigInt(f.orders ?? 1),
          dispatched: d(f.dispatched ?? '0'),
        })),
      );
    }
    if (sql.includes('AS "sales_pen"')) {
      return Promise.resolve([
        { sales_pen: seeds.noLine === undefined || seeds.noLine === null ? null : d(seeds.noLine) },
      ]);
    }
    if (sql.includes('GROUP BY 1')) {
      return Promise.resolve(
        Object.entries(seeds.invoiced ?? {}).map(([id, qty]) => ({
          sales_order_item_id: id,
          qty: d(qty),
        })),
      );
    }
    return Promise.resolve(seeds.lines.map(lineRow));
  });
  const module = await Test.createTestingModule({
    providers: [
      SalesByMaterialService,
      { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
    ],
  }).compile();
  return { service: module.get(SalesByMaterialService), calls };
}

// D-369: el teórico sale de la bobina (1000 mm × 0.30 mm × 7.85) y **sin** el 1 % de D-165.
const RAW_KG_PER_M = new Decimal('1000').times('0.30').times('7.85').div(1000);
// Con el 1 %: lo que planta descuenta por metro. Solo para fijar que el reporte ya no lo usa.
const KG_PER_M = kgPerMeter({ widthMm: '1000', thicknessMm: '0.30', densityFactor: '7.85' });

describe('SalesByMaterialService (D-354)', () => {
  it('una cobertura facturada y producida entera: ML, teórico, real, costo y los por-kilo', async () => {
    const { service, calls } = await build({
      lines: [{ qty: '100.000', subtotal: '3000.0000' }],
      invoiced: { 'soi-1': '100.000' },
      facts: { 'soi-1': { produced: '100.000' } },
      usage: [
        // B-1 roló los 100 m; B-2 solo aportó el despunte al cerrar (sin metros).
        { item: 'soi-1', coil: 'B-1', kg: '200.000', cost: '500.0000', meters: '100.000' },
        { item: 'soi-1', coil: 'B-2', kg: '40.000', cost: '100.0000' },
      ],
    });

    const report = await service.report(SEPT);

    // Presupuesto fijo: cuatro consultas, sin importar cuántas líneas haya.
    expect(calls).toHaveLength(5);
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row).toMatchObject({ kind: 'COBERTURA', thicknessMm: '0.30', colorLabel: 'ROJO' });
    expect(row.metersSold).toBe('100.000');
    expect(row.theoreticalKg).toBe(RAW_KG_PER_M.times(100).toFixed(3));
    expect(row.realKg).toBe('240.000');
    expect(row.costPen).toBe('600.0000');
    expect(row.profitPen).toBe('2400.0000');
    expect(row.costPerKgPen).toBe('2.5000');
    expect(row.pricePerKgPen).toBe('12.5000');
    expect(row.marginPerKgPen).toBe('10.0000');
    expect(row.yieldKg).toBe(RAW_KG_PER_M.times(100).minus(240).toFixed(3));
    expect(row.coils.map((c) => [c.code, c.kg, c.costPen, c.theoreticalKg, c.meters])).toEqual([
      ['B-1', '200.000', '500.0000', '235.500', '100.000'],
      ['B-2', '40.000', '100.0000', '0.000', '0.000'],
    ]);
    expect(row.coils[0]).toMatchObject({ typeKey: 'PREP-0.30', avgCostPen: '2.5' });
    expect(row.coils[0]?.documents).toEqual([
      {
        documentId: '00000000-0000-0000-0000-000000000001',
        documentNumber: 'F001-1',
        issueDate: '2026-09-10',
        customerName: 'CLIENTE SAC',
        kg: '200.000',
        meters: '100.000',
      },
    ]);
    expect(report.untraceable).toEqual([]);
  });

  it('D-369: el teórico sale de la bobina (1200 × 0.28, OP-26), no del SKU 0.30, y sin el 1 %', async () => {
    const { service } = await build({
      lines: [
        { doc: '1', qty: '60.000', subtotal: '1800.0000' },
        { doc: '2', qty: '40.000', subtotal: '1200.0000' },
        { doc: '3', docType: 'NOTA_CREDITO', qty: '10.000', subtotal: '300.0000' },
      ],
      invoiced: { 'soi-1': '90.000' },
      facts: { 'soi-1': { produced: '90.000' } },
      usage: [
        {
          item: 'soi-1',
          coil: 'B-26',
          kg: '240.000',
          cost: '600.0000',
          thickness: '0.28',
          width: '1200.00',
          meters: '90.000',
        },
      ],
    });
    const row = (await service.report(SEPT)).rows[0]!;
    // 90 m × 1200 × 0.28 × 7.85 ÷ 1000 = 237.384 kg.
    expect(row.theoreticalKg).toBe('237.384');
    expect(row.theoreticalKg).not.toBe(KG_PER_M.times(90).toFixed(3));
    const coil = row.coils[0]!;
    expect(coil).toMatchObject({ thicknessMm: '0.28', theoreticalKg: '237.384', kg: '240.000' });
    expect(coil.documents.map((doc) => [doc.documentNumber, doc.kg, doc.meters])).toEqual([
      ['F001-1', '160.000', '60.000'],
      ['F001-2', '106.667', '40.000'],
      ['F001-3', '-26.667', '-10.000'],
    ]);
  });

  it('peso real = consumo de las OP de la línea cuando lo facturado cubre lo producido', async () => {
    const usage = [
      { item: 'soi-1', coil: 'B-1', kg: '123.456', cost: '321.0000' },
      { item: 'soi-2', coil: 'B-1', kg: '10.500', cost: '30.0000' },
    ];
    const { service } = await build({
      lines: [
        { item: 'soi-1', qty: '50.000', subtotal: '1000.0000' },
        { item: 'soi-2', kind: 'ACCESORIO', qty: '5.000', subtotal: '200.0000' },
      ],
      invoiced: { 'soi-1': '50.000', 'soi-2': '5.000' },
      facts: { 'soi-1': { produced: '50.000' }, 'soi-2': { produced: '5.000' } },
      usage,
    });
    const report = await service.report(SEPT);
    const total = usage.reduce((acc, u) => acc.plus(u.kg), new Decimal(0));
    expect(report.total.realKg).toBe(total.toFixed(3));
    expect(report.subtotals.map((s) => s.kind)).toEqual(['COBERTURA', 'ACCESORIO']);
  });

  it('prorrateo: produjo de más, al comprobante le toca facturado ÷ producido del consumo', async () => {
    const { service } = await build({
      lines: [{ qty: '80.000', subtotal: '2400.0000' }],
      invoiced: { 'soi-1': '80.000' },
      facts: { 'soi-1': { produced: '100.000' } },
      usage: [{ item: 'soi-1', coil: 'B-1', kg: '250.000', cost: '600.0000' }],
    });
    const row = (await service.report(SEPT)).rows[0]!;
    // 80 de 100 m: el 80 % del material; el 20 % restante quedó en el almacén como stock.
    expect(row.realKg).toBe('200.000');
    expect(row.costPen).toBe('480.0000');
    expect(row.salesPen).toBe('2400.0000');
  });

  it('una línea facturada en dos meses: la suma de los dos meses es el total de la línea', async () => {
    const seeds = (month: 'sept' | 'oct'): Seeds => ({
      lines:
        month === 'sept'
          ? [{ doc: '1', issueDate: '2026-09-20', qty: '60.000', subtotal: '1800.0000' }]
          : [{ doc: '2', issueDate: '2026-10-05', qty: '40.000', subtotal: '1200.0000' }],
      invoiced: { 'soi-1': '100.000' },
      facts: { 'soi-1': { produced: '100.000' } },
      usage: [{ item: 'soi-1', coil: 'B-1', kg: '237.855', cost: '613.3333' }],
    });
    const sept = await (await build(seeds('sept'))).service.report(SEPT);
    const oct = await (await build(seeds('oct'))).service.report(OCT);
    const realKg = new Decimal(sept.total.realKg).plus(oct.total.realKg);
    const cost = new Decimal(sept.total.costPen).plus(oct.total.costPen);
    expect(realKg.toFixed(3)).toBe('237.855');
    expect(cost.toFixed(4)).toBe('613.3333');
  });

  it('facturó más de lo producido: la parte no producida va a «No trazable»', async () => {
    const { service } = await build({
      lines: [{ qty: '100.000', subtotal: '3000.0000' }],
      invoiced: { 'soi-1': '100.000' },
      facts: { 'soi-1': { produced: '40.000' } },
      usage: [{ item: 'soi-1', coil: 'B-1', kg: '95.000', cost: '250.0000' }],
    });
    const report = await service.report(SEPT);
    expect(report.rows[0]!.salesPen).toBe('1200.0000');
    expect(report.rows[0]!.metersSold).toBe('40.000');
    expect(report.rows[0]!.realKg).toBe('95.000');
    expect(report.untraceable).toHaveLength(1);
    expect(report.untraceable[0]).toMatchObject({
      reason: 'PRODUCCION_PARCIAL',
      salesPen: '1800.0000',
      metersSold: '60.000',
    });
    expect(report.untraceableSalesPen).toBe('1800.0000');
    // El cuadre suma trazable + no trazable.
    expect(report.reconciliation.lineSalesPen).toBe('3000.0000');
  });

  it('sin producción aún, desde stock y sin pedido: no trazables con su motivo, nunca estimados', async () => {
    const { service } = await build({
      lines: [
        { doc: '1', item: 'soi-1', qty: '10.000', subtotal: '300.0000' },
        {
          doc: '2',
          item: 'soi-2',
          kind: 'PLANCHA',
          lengthMm: '3600',
          qty: '5.000',
          subtotal: '400.0000',
        },
        { doc: '3', item: null, qty: '2.000', subtotal: '60.0000' },
      ],
      invoiced: { 'soi-1': '10.000', 'soi-2': '5.000' },
      facts: {
        'soi-1': { produced: '0', orders: 1 },
        'soi-2': { produced: '0', orders: 0, dispatched: '5.000' },
      },
    });
    const report = await service.report(SEPT);
    expect(report.rows).toEqual([]);
    expect(report.untraceable.map((u) => [u.reason, u.salesPen, u.metersSold])).toEqual([
      ['SIN_PRODUCCION', '300.0000', '10.000'],
      // Plancha: ML = cantidad × largo del SKU.
      ['DESDE_STOCK', '400.0000', '18.000'],
      ['SIN_PEDIDO', '60.0000', '2.000'],
    ]);
    expect(report.total.salesPen).toBe('0.0000');
    expect(report.reconciliation.lineSalesPen).toBe('760.0000');
  });

  it('bobina entera: peso real = kilos vendidos, ML teórico de sus kilos, costo de su salida', async () => {
    const { service } = await build({
      lines: [{ item: 'soi-9', coilSale: true, qty: '1189.275', subtotal: '4000.0000' }],
      invoiced: { 'soi-9': '1189.275' },
      facts: { 'soi-9': { produced: '0', orders: 0, dispatched: '1189.275' } },
      usage: [{ item: 'soi-9', coil: 'B-9', kg: '1189.275', cost: '3000.0000' }],
    });
    const report = await service.report(SEPT);
    const row = report.rows[0]!;
    expect(row.kind).toBe('BOBINA');
    expect(row.realKg).toBe('1189.275');
    expect(row.theoreticalKg).toBe('1189.275');
    expect(row.metersSold).toBe(new Decimal('1189.275').div(KG_PER_M).toFixed(3));
    expect(row.costPen).toBe('3000.0000');
    expect(report.reconciliation).toMatchObject({
      coilSalesPen: '4000.0000',
      lineSalesPen: '0.0000',
    });
  });

  it('bobina entera facturada y no despachada: no trazable «sin despacho»', async () => {
    const { service } = await build({
      lines: [{ item: 'soi-9', coilSale: true, qty: '500.000', subtotal: '1500.0000' }],
      invoiced: { 'soi-9': '500.000' },
    });
    const report = await service.report(SEPT);
    expect(report.untraceable.map((u) => u.reason)).toEqual(['SIN_DESPACHO']);
  });

  it('la nota de crédito resta venta y metros de la línea que afecta', async () => {
    const { service } = await build({
      lines: [
        { doc: '1', qty: '100.000', subtotal: '3000.0000' },
        { doc: '2', docType: 'NOTA_CREDITO', qty: '10.000', subtotal: '300.0000' },
      ],
      invoiced: { 'soi-1': '90.000' },
      facts: { 'soi-1': { produced: '90.000' } },
      usage: [{ item: 'soi-1', coil: 'B-1', kg: '216.000', cost: '540.0000' }],
    });
    const report = await service.report(SEPT);
    expect(report.rows[0]!.salesPen).toBe('2700.0000');
    expect(report.rows[0]!.metersSold).toBe('90.000');
    expect(report.rows[0]!.realKg).toBe('216.000');
  });

  it('los filtros de tipo, espesor y color no cambian el cuadre', async () => {
    const { service } = await build({
      lines: [
        { item: 'soi-1', qty: '10.000', subtotal: '300.0000' },
        { item: 'soi-2', thickness: '0.40', color: 'AZUL', qty: '10.000', subtotal: '500.0000' },
      ],
      invoiced: { 'soi-1': '10.000', 'soi-2': '10.000' },
      facts: { 'soi-1': { produced: '10.000' }, 'soi-2': { produced: '10.000' } },
    });
    const report = await service.report({ ...SEPT, thicknessMm: '0.4', color: 'azul' });
    expect(report.rows.map((r) => [r.thicknessMm, r.colorLabel])).toEqual([['0.40', 'AZUL']]);
    expect(report.total.salesPen).toBe('500.0000');
    expect(report.reconciliation.lineSalesPen).toBe('800.0000');
  });

  it('el ML sale de la unidad: plancha en kilos o en piezas sin largo → «No trazable», nunca un cero', async () => {
    const { service } = await build({
      lines: [
        {
          doc: '1',
          item: 'soi-1',
          kind: 'PLANCHA',
          unit: 'KGM',
          lengthMm: '3600',
          qty: '500.000',
          subtotal: '1500.0000',
        },
        { doc: '2', item: 'soi-2', kind: 'PLANCHA', qty: '4.000', subtotal: '200.0000' },
      ],
      invoiced: { 'soi-1': '500.000', 'soi-2': '4.000' },
      facts: { 'soi-1': { produced: '20.000' }, 'soi-2': { produced: '4.000' } },
      usage: [{ item: 'soi-1', coil: 'B-1', kg: '500.000', cost: '1250.0000' }],
    });
    const report = await service.report(SEPT);
    expect(report.rows).toEqual([]);
    expect(report.untraceable.map((u) => [u.reason, u.metersSold, u.salesPen])).toEqual([
      ['SIN_METRO', '0.000', '1500.0000'],
      ['SIN_METRO', '0.000', '200.0000'],
    ]);
    expect(report.reconciliation.lineSalesPen).toBe('1700.0000');
  });

  it('un producto de la línea sin subtipo cuenta en el cuadre y no en las filas', async () => {
    const { service } = await build({
      lines: [{ kind: null, qty: '1.000', subtotal: '99.0000' }],
    });
    const report = await service.report(SEPT);
    expect(report.rows).toEqual([]);
    expect(report.reconciliation.unclassifiedSalesPen).toBe('99.0000');
  });

  it('sin líneas de pedido en el rango no gasta más consultas', async () => {
    const { service, calls } = await build({ lines: [] });
    await service.report(SEPT);
    // Las líneas del rango y la venta sin línea (D-407), en paralelo.
    expect(calls).toHaveLength(2);
  });

  it('presupuesto fijo: cinco consultas con 1 línea y con 60 (sin N+1)', async () => {
    const seeds = (n: number): Seeds => {
      const items = Array.from({ length: n }, (_, i) => `soi-${String(i)}`);
      return {
        lines: items.map((item, i) => ({
          doc: String(i + 1),
          item,
          qty: '10.000',
          subtotal: '300.0000',
        })),
        invoiced: Object.fromEntries(items.map((id) => [id, '10.000'])),
        facts: Object.fromEntries(items.map((id) => [id, { produced: '10.000' }])),
        usage: items.map((item) => ({ item, coil: 'B-1', kg: '24.000', cost: '60.0000' })),
      };
    };
    for (const n of [1, 60]) {
      const { service, calls } = await build(seeds(n));
      const report = await service.report(SEPT);
      expect(calls).toHaveLength(5);
      expect(report.rows[0]!.lineCount).toBe(n);
    }
  });
});

/**
 * cc24 (D-406, D-407, D-413..D-415): «Ventas por material» por línea. Coberturas Aluzinc sigue
 * igual (por defecto); Drywall agrupa los perfiles por espesor del fleje, con «Galvanizado», y
 * deja lo comprado en el cuadre. La venta sin producto se declara aparte.
 */
describe('SalesByMaterialService — por línea (cc24)', () => {
  const DRY = { ...SEPT, businessLine: 'drywall' } as const;

  it('sin pestaña es Coberturas Aluzinc, y la consulta filtra por la línea pedida', async () => {
    const aluzinc = await build({ lines: [] });
    expect((await aluzinc.service.report(SEPT)).businessLine).toBe('metallic-roofing');
    const drywall = await build({ lines: [] });
    expect((await drywall.service.report(DRY)).businessLine).toBe('drywall');
  });

  it('un perfil producido para su línea: fila Perfiles × espesor, «Galvanizado», teórico = piezas × kg/pieza', async () => {
    const { service } = await build({
      lines: [
        {
          drywall: { source: 'MANUFACTURED', pieceWeightKg: '1.500' },
          qty: '100',
          subtotal: '1200.0000',
        },
      ],
      invoiced: { 'soi-1': '100' },
      facts: { 'soi-1': { produced: '100' } },
      usage: [
        { item: 'soi-1', coil: 'F-1', kg: '120.000', cost: '360.0000' },
        { item: 'soi-1', coil: 'F-2', kg: '40.000', cost: '120.0000' },
      ],
    });
    const report = await service.report(DRY);
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row).toMatchObject({
      kind: 'PERFIL',
      thicknessMm: '0.45',
      colorLabel: 'Galvanizado',
      // 100 piezas × 3 m.
      metersSold: '300.000',
      theoreticalKg: '150.000',
      realKg: '160.000',
      yieldKg: '-10.000',
      salesPen: '1200.0000',
      costPen: '480.0000',
    });
    // Metros y teórico se reparten entre los flejes por sus kilos (3:1).
    expect(row.coils.map((c) => [c.code, c.meters, c.theoreticalKg])).toEqual([
      ['F-1', '225.000', '112.500'],
      ['F-2', '75.000', '37.500'],
    ]);
  });

  it('un perfil hecho a stock (sin OP propia) es no trazable «desde stock», nunca estimado', async () => {
    const { service } = await build({
      lines: [{ drywall: { source: 'MANUFACTURED' }, qty: '50', subtotal: '600.0000' }],
      invoiced: { 'soi-1': '50' },
      facts: { 'soi-1': { produced: '0', orders: 0, dispatched: '50' } },
    });
    const report = await service.report(DRY);
    expect(report.rows).toEqual([]);
    expect(report.untraceable).toMatchObject([
      { kind: 'PERFIL', reason: 'DESDE_STOCK', salesPen: '600.0000', colorLabel: 'Galvanizado' },
    ]);
    expect(report.reconciliation.lineSalesPen).toBe('600.0000');
  });

  it('un producto comprado de Drywall cuenta en el cuadre y no en las filas', async () => {
    const { service } = await build({
      lines: [{ drywall: { source: 'PURCHASED' }, qty: '10', subtotal: '80.0000' }],
    });
    const report = await service.report(DRY);
    expect(report.rows).toEqual([]);
    expect(report.untraceable).toEqual([]);
    expect(report.reconciliation).toMatchObject({
      lineSalesPen: '80.0000',
      unclassifiedSalesPen: '80.0000',
    });
  });

  it('cuadre de la línea = filas + no trazable + sin subtipo, sin contar la bobina entera', async () => {
    const { service } = await build({
      lines: [
        {
          doc: '1',
          item: 'soi-1',
          drywall: { source: 'MANUFACTURED' },
          qty: '100',
          subtotal: '1000.0000',
        },
        {
          doc: '2',
          item: 'soi-2',
          drywall: { source: 'MANUFACTURED' },
          qty: '20',
          subtotal: '250.0000',
        },
        { doc: '3', item: null, drywall: { source: 'PURCHASED' }, qty: '5', subtotal: '40.0000' },
        { doc: '4', item: 'soi-4', coilSale: true, qty: '1000.000', subtotal: '4000.0000' },
      ],
      invoiced: { 'soi-1': '100', 'soi-2': '20', 'soi-4': '1000.000' },
      facts: { 'soi-1': { produced: '100' }, 'soi-2': { produced: '0', orders: 0 } },
      usage: [
        { item: 'soi-1', coil: 'F-1', kg: '150.000', cost: '450.0000' },
        { item: 'soi-4', coil: 'B-9', kg: '1000.000', cost: '3000.0000' },
      ],
    });
    const report = await service.report(DRY);
    const rows = report.rows.filter((r) => r.kind !== 'BOBINA');
    const coil = report.rows.filter((r) => r.kind === 'BOBINA');
    const untraceable = report.untraceable.filter((u) => u.kind !== 'BOBINA');
    const lineSum = new Decimal(0)
      .plus(rows.reduce((acc, r) => acc.plus(r.salesPen), new Decimal(0)))
      .plus(untraceable.reduce((acc, u) => acc.plus(u.salesPen), new Decimal(0)))
      .plus(report.reconciliation.unclassifiedSalesPen);
    expect(lineSum.toFixed(4)).toBe(report.reconciliation.lineSalesPen);
    expect(report.reconciliation.lineSalesPen).toBe('1290.0000');
    // D-413: la bobina entera de Drywall se queda en su pestaña, en la otra parte del cuadre.
    expect(coil.map((r) => r.salesPen)).toEqual(['4000.0000']);
    expect(report.reconciliation.coilSalesPen).toBe('4000.0000');
  });

  it('D-407: la venta sin producto del rango se declara, con signo', async () => {
    const withNoLine = await build({ lines: [], noLine: '35.5000' });
    expect((await withNoLine.service.report(SEPT)).noLineSalesPen).toBe('35.5000');
    const none = await build({ lines: [], noLine: null });
    expect((await none.service.report(DRY)).noLineSalesPen).toBe('0.0000');
  });

  it('una línea fuera de la matriz no pasa la validación', () => {
    expect(
      salesByMaterialQuerySchema.safeParse({ ...SEPT, businessLine: 'services' }).success,
    ).toBe(false);
    expect(salesByMaterialQuerySchema.safeParse({ ...SEPT, businessLine: 'acero' }).success).toBe(
      false,
    );
    expect(salesByMaterialQuerySchema.safeParse(DRY).success).toBe(true);
  });
});

/** cc24 (D-417): Coberturas (UPVC) y Reventa van por producto, con tres consultas fijas. */
describe('SalesByMaterialService — por producto (cc24, D-417)', () => {
  const DOC = '00000000-0000-0000-0000-000000000001';
  const productLine = (over: Record<string, unknown>): Record<string, unknown> => ({
    document_id: DOC,
    number: 'F001-1',
    doc_type: 'FACTURA',
    issue_date: new Date('2026-09-10T00:00:00.000Z'),
    order_seq: 7,
    product_id: 'p-1',
    sku: 'UPVC-01',
    name: 'Teja UPVC',
    unit: 'NIU',
    qty: d('10'),
    subtotal_pen: d('500.0000'),
    shown_elsewhere: false,
    ...over,
  });

  it('UPVC: fila por producto con el costo de kardex del despacho declarado', async () => {
    const { service, calls } = await build({
      lines: [],
      productLines: [productLine({})],
      declared: [
        {
          invoice_id: DOC,
          product_id: 'p-1',
          qty: d('10'),
          cost_pen: d('320.0000'),
          untraceable: false,
          costed_qty: d('10'),
        },
      ],
    });
    const report = await service.report({ ...SEPT, businessLine: 'roofing' });
    expect(report.rows).toEqual([]);
    expect(report.products?.rows).toEqual([
      {
        sku: 'UPVC-01',
        name: 'Teja UPVC',
        unit: 'NIU',
        qty: '10.000',
        salesPen: '500.0000',
        costPen: '320.0000',
        profitPen: '180.0000',
        costPerUnitPen: '32.0000',
        lineCount: 1,
      },
    ]);
    expect(report.reconciliation.lineSalesPen).toBe('500.0000');
    // Las líneas, la venta sin línea y lo despachado: tres, fijas.
    expect(calls).toHaveLength(3);
  });

  it('Reventa: la bobina entera de otra pestaña solo cuenta en el cuadre (D-413)', async () => {
    const { service } = await build({
      lines: [],
      productLines: [
        productLine({ sku: 'BOBALZ030', shown_elsewhere: true, subtotal_pen: d('4000.0000') }),
      ],
    });
    const report = await service.report({ ...SEPT, businessLine: 'trading' });
    expect(report.products?.rows).toEqual([]);
    expect(report.products?.untraceable).toEqual([]);
    expect(report.reconciliation).toMatchObject({
      lineSalesPen: '4000.0000',
      coilSalesPen: '4000.0000',
    });
  });

  it('sin líneas no gasta la consulta de despachos', async () => {
    const { service, calls } = await build({ lines: [] });
    const report = await service.report({ ...SEPT, businessLine: 'trading' });
    expect(calls).toHaveLength(2);
    expect(report.products?.total.salesPen).toBe('0.0000');
  });
});
