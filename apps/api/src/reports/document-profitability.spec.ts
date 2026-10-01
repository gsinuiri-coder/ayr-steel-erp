import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assembleDocumentProfitability, notApplicable } from './document-profitability';
import { DocumentProfitabilityService } from './document-profitability.service';
import { assembleSalesByMaterial, type CoilUsage, type OrderLineFacts } from './sales-by-material';
import {
  SalesByMaterialService,
  toInvoiceLine,
  type DocumentLineRow,
  type EngineFacts,
} from './sales-by-material.service';

/**
 * C06 — la rentabilidad de un comprobante. Lo que se fija: el **cuadre** con «Ventas por
 * material» (mismo motor, mismo número), el costo del despacho declarado para lo que no es de
 * Coberturas Aluzinc (y «sin costo aún» sin despacho declarado, nunca 0 ni el del pedido), las
 * notas de crédito y el presupuesto de consultas.
 */

const d = (v: string): Prisma.Decimal => new Prisma.Decimal(v);
const DOC = '00000000-0000-0000-0000-000000000001';
const NC = '00000000-0000-0000-0000-000000000002';

interface RowSeed {
  item?: string;
  doc?: string;
  credit?: boolean;
  line?: number;
  orderItem?: string | null;
  engine?: boolean;
  kind?: 'A_MEDIDA' | 'ACCESORIO' | 'PLANCHA' | null;
  coilSale?: boolean;
  qty: string;
  subtotal: string;
  unit?: string | null;
  sku?: string | null;
  lineCode?: string;
  lengthMm?: string;
}

function row(s: RowSeed): DocumentLineRow {
  const credit = s.credit === true;
  const coil = s.coilSale === true;
  const engine = s.engine ?? true;
  return {
    document_id: s.doc ?? (credit ? NC : DOC),
    number: credit ? 'FC01-1' : 'F001-1',
    doc_type: credit ? 'NOTA_CREDITO' : 'FACTURA',
    issue_date: new Date('2026-08-10T00:00:00.000Z'),
    order_seq: 7,
    sales_order_item_id: s.orderItem === undefined ? 'soi-1' : s.orderItem,
    own_order_item_id: s.orderItem === undefined ? 'soi-1' : s.orderItem,
    qty: credit ? d(s.qty).negated() : d(s.qty),
    subtotal_pen: credit ? d(s.subtotal).negated() : d(s.subtotal),
    sku: s.sku === undefined ? (coil ? 'BOBALZROJ030' : 'COB030ROJO') : s.sku,
    unit: s.unit === undefined ? (coil ? 'KGM' : s.kind === 'PLANCHA' ? 'NIU' : 'MTR') : s.unit,
    is_coil_sale: coil,
    roofing_kind: !engine || coil ? null : s.kind === undefined ? 'A_MEDIDA' : s.kind,
    length_mm: s.lengthMm === undefined ? null : d(s.lengthMm),
    p_width: engine && !coil ? d('1000.00') : null,
    p_thickness: engine && !coil ? d('0.30') : null,
    p_density: engine && !coil ? d('7.8500') : null,
    p_finish_kind: engine && !coil ? 'PREPINTADO' : null,
    p_color: engine && !coil ? 'ROJO' : null,
    c_width: coil ? d('1000.00') : null,
    c_thickness: coil ? d('0.30') : null,
    c_density: coil ? d('7.8500') : null,
    c_finish_kind: coil ? 'PREPINTADO' : null,
    c_color: coil ? 'ROJO' : null,
    item_id: s.item ?? `11111111-1111-1111-1111-${String(s.line ?? 1).padStart(12, '0')}`,
    line_number: s.line ?? 1,
    description: 'línea',
    line_code: s.lineCode ?? (engine ? 'metallic-roofing' : 'trading'),
    in_engine: engine,
    is_credit: credit,
    customer_name: 'CLIENTE SAC',
  };
}

function engineFacts(
  facts: Record<string, Partial<OrderLineFacts>>,
  usage: Partial<CoilUsage>[] = [],
): EngineFacts {
  return {
    facts: new Map(
      Object.entries(facts).map(([id, f]) => [
        id,
        {
          invoicedQty: f.invoicedQty ?? '0',
          producedQty: f.producedQty ?? '0',
          orderCount: f.orderCount ?? 1,
          dispatchedQty: f.dispatchedQty ?? '0',
        },
      ]),
    ),
    usage: usage.map((u, i) => ({
      salesOrderItemId: u.salesOrderItemId ?? 'soi-1',
      coilId: u.coilId ?? `coil-${String(i)}`,
      code: u.code ?? `IMPO-${String(i)}`,
      thicknessMm: '0.30',
      colorLabel: 'ROJO',
      kg: u.kg ?? '0',
      costPen: u.costPen ?? '0',
      typeKey: 'PREP-0.30',
      widthMm: '1000.00',
      densityFactor: '7.8500',
      meters: u.meters ?? '0',
      avgCostPen: null,
    })),
  };
}

const HEADER = { id: DOC, number: 'F001-1', docType: 'FACTURA' };

describe('assembleDocumentProfitability (C06)', () => {
  it('cuadre: las líneas de Coberturas Aluzinc suman lo que el comprobante aporta a Ventas por material', () => {
    // Una cobertura producida entera, una plancha con producción parcial, una bobina entera.
    const rows = [
      row({ line: 1, orderItem: 'soi-1', qty: '100', subtotal: '3000' }),
      row({
        line: 2,
        orderItem: 'soi-2',
        kind: 'PLANCHA',
        qty: '10',
        subtotal: '900',
        lengthMm: '3600',
      }),
      row({ line: 3, orderItem: 'soi-3', coilSale: true, qty: '4000', subtotal: '20000' }),
    ];
    const engine = engineFacts(
      {
        'soi-1': { invoicedQty: '100', producedQty: '100' },
        'soi-2': { invoicedQty: '10', producedQty: '4' },
        'soi-3': { invoicedQty: '4000', producedQty: '0', orderCount: 0, dispatchedQty: '4000' },
      },
      [
        { salesOrderItemId: 'soi-1', kg: '250', costPen: '1000' },
        { salesOrderItemId: 'soi-2', kg: '40', costPen: '160' },
        { salesOrderItemId: 'soi-3', kg: '4000', costPen: '16000' },
      ],
    );
    const doc = assembleDocumentProfitability({
      document: HEADER,
      rows,
      engine,
      declared: new Map(),
      hasDeclaredDispatch: false,
    });
    const report = assembleSalesByMaterial({
      query: { from: '2026-08-01', to: '2026-08-31' },
      lines: rows.map((r) => toInvoiceLine({ ...r, sku: r.sku ?? '', unit: r.unit ?? '' })),
      facts: engine.facts,
      usage: engine.usage,
    });

    expect(doc.materialTotal.salesPen).toBe(report.total.salesPen);
    expect(doc.materialTotal.costPen).toBe(report.total.costPen);
    expect(doc.materialTotal.realKg).toBe(report.total.realKg);
    expect(doc.materialTotal.metersSold).toBe(report.total.metersSold);
    expect(doc.uncostedSalesPen).toBe(report.untraceableSalesPen);
    // Todo es de Coberturas Aluzinc: el total del comprobante es el del material.
    expect(doc.total.costPen).toBe(doc.materialTotal.costPen);
    expect(doc.lines.map((l) => l.status)).toEqual(['COMPLETE', 'PARTIAL', 'COMPLETE']);
    expect(doc.lines[1]!.note).toBe('Producción parcial: la parte no producida');
    expect(doc.lines.every((l) => l.costBasis === 'COIL_KG')).toBe(true);
    expect(doc.lines[0]!.costBasisDetail).toBe('IMPO-0 (250.000 kg)');
  });

  it('cifras por kilo, por metro y por unidad de una cobertura', () => {
    const doc = assembleDocumentProfitability({
      document: HEADER,
      rows: [row({ qty: '100', subtotal: '3000' })],
      engine: engineFacts({ 'soi-1': { invoicedQty: '100', producedQty: '100' } }, [
        { kg: '250', costPen: '1000' },
      ]),
      declared: new Map(),
      hasDeclaredDispatch: false,
    });
    const [line] = doc.lines;
    expect(line).toEqual(
      expect.objectContaining({
        qty: '100.000',
        unit: 'MTR',
        metersSold: '100.000',
        realKg: '250.000',
        salesPen: '3000.0000',
        costPen: '1000.0000',
        profitPen: '2000.0000',
        marginPct: '66.67',
        pricePerKgPen: '12.0000',
        costPerKgPen: '4.0000',
        marginPerKgPen: '8.0000',
        pricePerMeterPen: '30.0000',
        costPerMeterPen: '10.0000',
        marginPerMeterPen: '20.0000',
        costPerUnitPen: '10.0000',
      }),
    );
  });

  it('sin producción todavía: «sin costo aún», con la venta aparte y sin cero', () => {
    const doc = assembleDocumentProfitability({
      document: HEADER,
      rows: [row({ qty: '100', subtotal: '3000' })],
      engine: engineFacts({ 'soi-1': { invoicedQty: '100', producedQty: '0' } }),
      declared: new Map(),
      hasDeclaredDispatch: false,
    });
    expect(doc.lines[0]).toEqual(
      expect.objectContaining({
        status: 'NO_COST_YET',
        uncostedSalesPen: '3000.0000',
        // Nada trazado: los kilos y los cocientes son «—», no un 0 que parezca dato.
        realKg: null,
        costPerUnitPen: null,
        pricePerKgPen: null,
      }),
    );
    expect(doc.total.salesPen).toBe('0.0000');
    expect(doc.total.marginPct).toBeNull();
    expect(doc.uncostedSalesPen).toBe('3000.0000');
  });

  it('reventa con despacho declarado: el costo de su SALE, con la base dicha', () => {
    const doc = assembleDocumentProfitability({
      document: HEADER,
      rows: [
        row({
          engine: false,
          sku: 'UPVC-1',
          unit: 'NIU',
          orderItem: 'soi-9',
          qty: '10',
          subtotal: '500',
        }),
      ],
      engine: engineFacts({}),
      declared: new Map([
        [
          'soi-9',
          { dispatchedQty: '10', costPen: '320', withoutMovement: false, dispatchSeqs: [18] },
        ],
      ]),
      hasDeclaredDispatch: true,
    });
    expect(doc.lines[0]).toEqual(
      expect.objectContaining({
        status: 'COMPLETE',
        costBasis: 'DISPATCH_SALE',
        costBasisDetail: 'DES-000018',
        costPen: '320.0000',
        profitPen: '180.0000',
        costPerUnitPen: '32.0000',
        // Sin kilos de bobina: por kilo no aplica.
        realKg: null,
        pricePerKgPen: null,
        // Sin largo ni metros: por ML no aplica.
        metersSold: null,
        pricePerMeterPen: null,
      }),
    );
    expect(doc.materialTotal.salesPen).toBe('0.0000');
  });

  it('despacho declarado parcial: se costea lo despachado y el resto queda sin costo', () => {
    const doc = assembleDocumentProfitability({
      document: HEADER,
      rows: [
        row({
          engine: false,
          sku: 'UPVC-1',
          unit: 'NIU',
          orderItem: 'soi-9',
          qty: '10',
          subtotal: '500',
        }),
      ],
      engine: engineFacts({}),
      declared: new Map([
        [
          'soi-9',
          { dispatchedQty: '4', costPen: '128', withoutMovement: false, dispatchSeqs: [18] },
        ],
      ]),
      hasDeclaredDispatch: true,
    });
    expect(doc.lines[0]).toEqual(
      expect.objectContaining({
        status: 'PARTIAL',
        salesPen: '200.0000',
        costPen: '128.0000',
        uncostedSalesPen: '300.0000',
        note: 'Despachado 4.000 de 10.000: el resto, sin costo aún',
      }),
    );
  });

  it('sin despacho declarado: «sin costo aún», nunca 0 ni el despacho del pedido (D-205)', () => {
    const doc = assembleDocumentProfitability({
      document: HEADER,
      rows: [
        row({
          engine: false,
          sku: 'UPVC-1',
          unit: 'NIU',
          orderItem: 'soi-9',
          qty: '10',
          subtotal: '500',
        }),
      ],
      engine: engineFacts({}),
      declared: new Map(),
      hasDeclaredDispatch: false,
    });
    expect(doc.lines[0]).toEqual(
      expect.objectContaining({
        status: 'NO_COST_YET',
        note: 'Sin despacho declarado en este comprobante (D-205)',
        costPen: '0.0000',
        uncostedSalesPen: '500.0000',
      }),
    );
    expect(doc.total.salesPen).toBe('0.0000');
  });

  it('servicio, entregado antes del inventario inicial y línea sin pedido', () => {
    const doc = assembleDocumentProfitability({
      document: HEADER,
      rows: [
        row({ line: 1, engine: false, lineCode: 'services', unit: 'ZZ', qty: '1', subtotal: '50' }),
        row({ line: 2, engine: false, orderItem: 'soi-8', unit: 'NIU', qty: '2', subtotal: '80' }),
        row({ line: 3, engine: false, orderItem: null, unit: 'NIU', qty: '1', subtotal: '10' }),
        row({ line: 4, engine: false, orderItem: 'soi-7', unit: 'NIU', qty: '1', subtotal: '10' }),
      ],
      engine: engineFacts({}),
      declared: new Map([
        ['soi-8', { dispatchedQty: '2', costPen: '0', withoutMovement: true, dispatchSeqs: [3] }],
      ]),
      hasDeclaredDispatch: true,
    });
    expect(doc.lines.map((l) => [l.status, l.note])).toEqual([
      ['NO_COST', 'Servicio: no lleva inventario, no tiene costo de kardex'],
      ['NO_COST', 'Entregado antes del inventario inicial: sin salida de kardex (D-278)'],
      ['UNTRACEABLE', 'Sin línea de pedido vinculada'],
      ['NO_COST_YET', 'El despacho declarado no incluye esta línea todavía'],
    ]);
  });

  it('producto de la línea sin subtipo: no trazable, sin inventar un tipo', () => {
    const doc = assembleDocumentProfitability({
      document: HEADER,
      rows: [row({ kind: null, qty: '1', subtotal: '10' })],
      engine: engineFacts({}),
      declared: new Map(),
      hasDeclaredDispatch: false,
    });
    expect(doc.lines[0]!.status).toBe('UNTRACEABLE');
  });

  it('nota de crédito: lo acreditado y el neto', () => {
    const doc = assembleDocumentProfitability({
      document: HEADER,
      rows: [
        row({ qty: '100', subtotal: '3000' }),
        row({ credit: true, qty: '20', subtotal: '600' }),
        row({
          credit: true,
          line: 2,
          engine: false,
          sku: 'UPVC-1',
          unit: 'NIU',
          qty: '1',
          subtotal: '50',
        }),
      ],
      engine: engineFacts({ 'soi-1': { invoicedQty: '80', producedQty: '80' } }, [
        { kg: '200', costPen: '800' },
      ]),
      declared: new Map(),
      hasDeclaredDispatch: false,
    });
    expect(doc.credited).not.toBeNull();
    expect(doc.credited!.notes).toEqual([{ id: NC, number: 'FC01-1' }]);
    // Facturado neto de la línea: 100 − 20 = 80, todo producido: el comprobante traza entero.
    expect(doc.total.costPen).toBe('1000.0000');
    // La NC resta en venta y en costo (el motor le da su parte con signo).
    expect(doc.credited!.lines[0]!.salesPen).toBe('-600.0000');
    expect(doc.credited!.total.costPen).toBe('-200.0000');
    // Revisión C06 (P1): la línea de reventa acreditada resta su venta con costo 0.
    expect(doc.credited!.lines[1]).toEqual(
      expect.objectContaining({
        status: 'NO_COST',
        costBasis: null,
        salesPen: '-50.0000',
        costPen: '0.0000',
        uncostedSalesPen: '0.0000',
      }),
    );
    expect(doc.credited!.total.salesPen).toBe('-650.0000');
    expect(doc.net).toEqual(
      expect.objectContaining({
        salesPen: '2350.0000',
        costPen: '800.0000',
        profitPen: '1550.0000',
      }),
    );
  });

  it('una nota de crédito vista por sí misma: su reventa resta la venta, sin buscar despacho', () => {
    const doc = assembleDocumentProfitability({
      document: { id: NC, number: 'FC01-1', docType: 'NOTA_CREDITO' },
      rows: [
        row({ doc: NC, engine: false, sku: 'UPVC-1', unit: 'NIU', qty: '-1', subtotal: '-50' }),
      ],
      engine: engineFacts({}),
      declared: new Map(),
      hasDeclaredDispatch: false,
    });
    expect(doc.lines[0]).toEqual(
      expect.objectContaining({ status: 'NO_COST', salesPen: '-50.0000', costPen: '0.0000' }),
    );
    expect(doc.credited).toBeNull();
  });

  it('un comprobante que no es venta viva no calcula nada', () => {
    const dto = notApplicable(HEADER, 'Una guía de remisión no es una venta');
    expect(dto.applies).toBe(false);
    expect(dto.lines).toEqual([]);
    expect(dto.total.marginPct).toBeNull();
  });
});

describe('DocumentProfitabilityService (C06)', () => {
  async function build(opts: {
    doc?: { docType?: string; status?: string; archivedAt?: Date | null } | null;
    rows: DocumentLineRow[];
    declared?: Record<string, unknown>[];
  }) {
    const calls: string[] = [];
    const queryRaw = jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      calls.push(sql);
      if (sql.includes('"dispatched_qty"')) return Promise.resolve(opts.declared ?? []);
      if (sql.includes('"in_engine"')) return Promise.resolve(opts.rows);
      if (sql.includes('WITH ops AS')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const findUnique = jest.fn(() =>
      Promise.resolve(
        opts.doc === null
          ? null
          : {
              id: DOC,
              number: 'F001-1',
              docType: opts.doc?.docType ?? 'FACTURA',
              status: opts.doc?.status ?? 'ACCEPTED',
              archivedAt: opts.doc?.archivedAt ?? null,
            },
      ),
    );
    const prisma = { $queryRaw: queryRaw, fiscalDocument: { findUnique } };
    const module = await Test.createTestingModule({
      providers: [
        DocumentProfitabilityService,
        SalesByMaterialService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    return { service: module.get(DocumentProfitabilityService), calls, findUnique };
  }

  it('presupuesto fijo: seis consultas con una línea o con cien (sin N+1)', async () => {
    const mixed = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        i % 2 === 0
          ? row({ line: i + 1, orderItem: `soi-${String(i)}`, qty: '1', subtotal: '10' })
          : row({
              line: i + 1,
              engine: false,
              orderItem: `soi-${String(i)}`,
              unit: 'NIU',
              qty: '1',
              subtotal: '10',
            }),
      );
    const one = await build({ rows: mixed(2) });
    await one.service.profitability(DOC);
    const hundred = await build({ rows: mixed(100) });
    await hundred.service.profitability(DOC);
    // Comprobante (1, no es $queryRaw) + líneas + tres del motor + despachos declarados.
    expect(one.findUnique).toHaveBeenCalledTimes(1);
    expect(one.calls).toHaveLength(5);
    expect(hundred.calls).toHaveLength(5);
  });

  it('solo Coberturas Aluzinc: no consulta despachos; solo reventa: no consulta el motor', async () => {
    const engineOnly = await build({ rows: [row({ qty: '1', subtotal: '10' })] });
    await engineOnly.service.profitability(DOC);
    expect(engineOnly.calls.some((c) => c.includes('"dispatched_qty"'))).toBe(false);
    expect(engineOnly.calls).toHaveLength(4);

    const tradingOnly = await build({
      rows: [row({ engine: false, unit: 'NIU', qty: '1', subtotal: '10' })],
    });
    await tradingOnly.service.profitability(DOC);
    expect(tradingOnly.calls).toHaveLength(2);
  });

  it('una nota de crédito no consulta despachos', async () => {
    const b = await build({
      doc: { docType: 'NOTA_CREDITO' },
      rows: [row({ engine: false, unit: 'NIU', qty: '1', subtotal: '10' })],
    });
    await b.service.profitability(DOC);
    expect(b.calls.some((c) => c.includes('"dispatched_qty"'))).toBe(false);
  });

  it('404 si no existe; no aplica a guías, archivados ni anulados, y no consulta más', async () => {
    const missing = await build({ doc: null, rows: [] });
    await expect(missing.service.profitability(DOC)).rejects.toThrow('Comprobante no encontrado');

    for (const doc of [
      { docType: 'GUIA_REMISION_REMITENTE' },
      { archivedAt: new Date() },
      { status: 'ANNULLED' },
    ]) {
      const b = await build({ doc, rows: [] });
      const dto = await b.service.profitability(DOC);
      expect(dto.applies).toBe(false);
      expect(dto.notApplicableReason).not.toBeNull();
      expect(b.calls).toHaveLength(0);
    }
  });

  it('pasa el costo de los despachos declarados al armado', async () => {
    const b = await build({
      rows: [row({ engine: false, orderItem: 'soi-9', unit: 'NIU', qty: '10', subtotal: '500' })],
      declared: [
        {
          sales_order_item_id: 'soi-9',
          dispatched_qty: d('10'),
          cost_pen: d('320'),
          without_movement: false,
          dispatch_seqs: [18, 4],
        },
      ],
    });
    const dto = await b.service.profitability(DOC);
    expect(dto.lines[0]).toEqual(
      expect.objectContaining({ costPen: '320.0000', costBasisDetail: 'DES-000004, DES-000018' }),
    );
  });
});
