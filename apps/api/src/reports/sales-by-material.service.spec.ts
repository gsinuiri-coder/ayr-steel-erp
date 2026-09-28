import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { Decimal, kgPerMeter, type SalesByMaterialQuery } from '@ayr/shared';
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
}

interface Seeds {
  lines: LineSeed[];
  invoiced?: Record<string, string>;
  facts?: Record<string, { produced: string; orders?: number; dispatched?: string }>;
  usage?: { item: string; coil: string; kg: string; cost: string; thickness?: string }[];
}

function lineRow(s: LineSeed): Record<string, unknown> {
  const nc = s.docType === 'NOTA_CREDITO';
  const coil = s.coilSale === true;
  return {
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
  };
}

async function build(seeds: Seeds): Promise<{ service: SalesByMaterialService; calls: string[] }> {
  const calls: string[] = [];
  const queryRaw = jest.fn((strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    calls.push(sql);
    if (sql.includes('WITH ops AS')) {
      return Promise.resolve(
        (seeds.usage ?? []).map((u) => ({
          sales_order_item_id: u.item,
          coil_id: `coil-${u.coil}`,
          code: u.coil,
          thickness_mm: d(u.thickness ?? '0.30'),
          finish_kind: 'PREPINTADO',
          color_name: 'ROJO',
          kg: d(u.kg),
          cost_pen: d(u.cost),
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

// 1000 mm × 0.30 mm × 7.85 × 1.01 (D-165).
const KG_PER_M = kgPerMeter({ widthMm: '1000', thicknessMm: '0.30', densityFactor: '7.85' });

describe('SalesByMaterialService (D-354)', () => {
  it('una cobertura facturada y producida entera: ML, teórico, real, costo y los por-kilo', async () => {
    const { service, calls } = await build({
      lines: [{ qty: '100.000', subtotal: '3000.0000' }],
      invoiced: { 'soi-1': '100.000' },
      facts: { 'soi-1': { produced: '100.000' } },
      usage: [
        { item: 'soi-1', coil: 'B-1', kg: '200.000', cost: '500.0000' },
        { item: 'soi-1', coil: 'B-2', kg: '40.000', cost: '100.0000' },
      ],
    });

    const report = await service.report(SEPT);

    // Presupuesto fijo: cuatro consultas, sin importar cuántas líneas haya.
    expect(calls).toHaveLength(4);
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row).toMatchObject({ kind: 'COBERTURA', thicknessMm: '0.30', colorLabel: 'ROJO' });
    expect(row.metersSold).toBe('100.000');
    expect(row.theoreticalKg).toBe(KG_PER_M.times(100).toFixed(3));
    expect(row.realKg).toBe('240.000');
    expect(row.costPen).toBe('600.0000');
    expect(row.profitPen).toBe('2400.0000');
    expect(row.costPerKgPen).toBe('2.5000');
    expect(row.pricePerKgPen).toBe('12.5000');
    expect(row.marginPerKgPen).toBe('10.0000');
    expect(row.yieldKg).toBe(KG_PER_M.times(100).minus(240).toFixed(3));
    expect(row.coils.map((c) => [c.code, c.kg, c.costPen])).toEqual([
      ['B-1', '200.000', '500.0000'],
      ['B-2', '40.000', '100.0000'],
    ]);
    expect(report.untraceable).toEqual([]);
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
    expect(report.reconciliation.roofingSalesPen).toBe('3000.0000');
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
    expect(report.reconciliation.roofingSalesPen).toBe('760.0000');
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
      roofingSalesPen: '0.0000',
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
    expect(report.reconciliation.roofingSalesPen).toBe('800.0000');
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
    expect(report.reconciliation.roofingSalesPen).toBe('1700.0000');
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
    expect(calls).toHaveLength(1);
  });

  it('presupuesto fijo: cuatro consultas con 1 línea y con 60 (sin N+1)', async () => {
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
      expect(calls).toHaveLength(4);
      expect(report.rows[0]!.lineCount).toBe(n);
    }
  });
});
