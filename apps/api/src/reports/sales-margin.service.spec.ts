import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { LIVE_DOCUMENT_STATUSES, salesMarginQuerySchema, sum as decimalSum } from '@ayr/shared';
import { SalesMarginService } from './sales-margin.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * RF-S4a/M2.
 *
 * Lo que se prueba acá es el **criterio**, no la aritmética: de dónde sale el costo, cuándo
 * es comparable con la venta del rango y cuándo el reporte tiene que decir que no lo sabe.
 * Ese es el lugar donde un reporte de margen miente sin que nadie lo note, porque un número
 * plausible se lee igual que uno correcto.
 *
 * Las seis consultas se simulan por separado; el despacho del mock es por el texto del SQL y
 * no por el orden, para que reordenarlas no cambie en silencio lo que cada caso prueba.
 */

const RANGE = { from: '2026-09-01', to: '2026-09-30' };

function decimal(v: string): Prisma.Decimal {
  return new Prisma.Decimal(v);
}

interface DocSeed {
  id: string;
  number?: string;
  docType?: 'FACTURA' | 'BOLETA' | 'NOTA_CREDITO';
  orderId?: string | null;
  orderSeq?: number | null;
  subtotal: string;
  issueDate?: string;
  customer?: string;
  seller?: string | null;
}

function docRow(seed: DocSeed): Record<string, unknown> {
  return {
    id: seed.id,
    number: seed.number ?? `F001-${seed.id}`,
    doc_type: seed.docType ?? 'FACTURA',
    status: 'ACCEPTED',
    origin: 'ISSUED_HERE',
    issue_date: new Date(`${seed.issueDate ?? '2026-09-10'}T00:00:00.000Z`),
    subtotal_pen: decimal(seed.subtotal),
    sales_order_id: seed.orderId === undefined ? 'o1' : seed.orderId,
    order_seq: seed.orderSeq === undefined ? 1 : seed.orderSeq,
    customer_name: seed.customer ?? 'Cliente S.A.',
    seller_name: seed.seller ?? 'Vendedor Uno',
  };
}

interface Seeds {
  documents?: DocSeed[];
  outside?: { orderId: string; count: number }[];
  costs?: { orderId: string; invoiceId?: string | null; line?: string; cost: string }[];
  opMaterial?: { orderId: string; material: string }[];
  salesByLine?: { documentId: string; line: string | null; subtotal: string }[];
  pending?: { orderId: string; pending: boolean; untraceable?: boolean }[];
}

async function buildService(
  seeds: Seeds,
): Promise<{ service: SalesMarginService; calls: string[]; params: unknown[][] }> {
  const calls: string[] = [];
  const params: unknown[][] = [];
  const queryRaw = jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(' ');
    calls.push(sql);
    params.push(values);
    if (sql.includes('BOOL_OR')) {
      return Promise.resolve(
        (seeds.pending ?? []).map((p) => ({
          sales_order_id: p.orderId,
          pending: p.pending,
          untraceable: p.untraceable ?? false,
        })),
      );
    }
    if (sql.includes('AS "outside"')) {
      return Promise.resolve(
        (seeds.outside ?? []).map((o) => ({
          sales_order_id: o.orderId,
          outside: BigInt(o.count),
        })),
      );
    }
    if (sql.includes('AS "cost_pen"')) {
      return Promise.resolve(
        (seeds.costs ?? []).map((c) => ({
          sales_order_id: c.orderId,
          invoice_id: c.invoiceId ?? null,
          business_line_code: c.line ?? 'drywall',
          cost_pen: decimal(c.cost),
        })),
      );
    }
    if (sql.includes('AS "material_pen"')) {
      return Promise.resolve(
        (seeds.opMaterial ?? []).map((m) => ({
          sales_order_id: m.orderId,
          material_pen: decimal(m.material),
        })),
      );
    }
    if (sql.includes('"fiscal_document_items" fdi')) {
      return Promise.resolve(
        (seeds.salesByLine ?? []).map((s) => ({
          document_id: s.documentId,
          business_line_code: s.line,
          subtotal_pen: decimal(s.subtotal),
        })),
      );
    }
    return Promise.resolve((seeds.documents ?? []).map(docRow));
  });

  const module: TestingModule = await Test.createTestingModule({
    providers: [SalesMarginService, { provide: PrismaService, useValue: { $queryRaw: queryRaw } }],
  }).compile();

  return { service: module.get(SalesMarginService), calls, params };
}

describe('SalesMarginService', () => {
  it('los estados vivos son LIVE_DOCUMENT_STATUSES, el mismo corte que Ventas por material', async () => {
    // C06: la copia local se unificó porque era literalmente este conjunto; si alguien cambia
    // la constante compartida, los dos reportes se mueven juntos y este test lo dice.
    expect([...LIVE_DOCUMENT_STATUSES].sort()).toEqual(
      ['ACCEPTED', 'ISSUED', 'SEND_ERROR', 'VOID_PENDING'].sort(),
    );
    const { service, calls, params } = await buildService({
      documents: [{ id: 'd1', subtotal: '10.0000' }],
      pending: [{ orderId: 'o1', pending: false }],
    });
    await service.salesMargin(RANGE);
    const liveLists = params
      .flat()
      .filter(
        (v): v is { values: unknown[]; strings: string[] } =>
          typeof v === 'object' && v !== null && 'values' in v && 'strings' in v,
      )
      .map((v) => v.values);
    // Documentos, fuera de rango y pendientes de despacho: las tres consultas que cortan por estado.
    expect(liveLists).toHaveLength(3);
    for (const list of liveLists) expect(list).toEqual([...LIVE_DOCUMENT_STATUSES]);
    expect(calls.some((sql) => sql.includes("IN ('ISSUED'"))).toBe(false);
  });

  it('la venta va sin IGV y la nota de crédito resta', async () => {
    const { service } = await buildService({
      documents: [
        { id: 'd1', subtotal: '1000.0000' },
        { id: 'd2', subtotal: '250.0000', docType: 'NOTA_CREDITO' },
      ],
      costs: [{ orderId: 'o1', cost: '600.0000' }],
    });

    const report = await service.salesMargin(RANGE);

    expect(report.orders).toHaveLength(1);
    expect(report.orders[0]!.salesPen).toBe('750.0000');
    expect(report.orders[0]!.costPen).toBe('600.0000');
    expect(report.orders[0]!.marginPen).toBe('150.0000');
    // Margen **sobre venta** (§7): 150 / 750 = 20 %.
    expect(report.orders[0]!.marginPct).toBe('20.00');
  });

  it('el material de las OPs viaja aparte y no toca el margen', async () => {
    const { service } = await buildService({
      documents: [{ id: 'd1', subtotal: '1000.0000' }],
      costs: [{ orderId: 'o1', cost: '600.0000' }],
      // Produjo de más: 900 de material para un costo de venta de 600. La diferencia se queda
      // en el almacén como stock libre y no es costo de esta venta.
      opMaterial: [{ orderId: 'o1', material: '900.0000' }],
    });

    const report = await service.salesMargin(RANGE);
    const order = report.orders[0]!;

    expect(order.opMaterialCostPen).toBe('900.0000');
    expect(order.costPen).toBe('600.0000');
    expect(order.marginPen).toBe('400.0000');
    expect(report.totals.costPen).toBe('600.0000');
  });

  describe('cuándo el costo es comparable con la venta del rango', () => {
    it('sin comprobantes fuera del rango y todo despachado: COMPLETO y entra a los totales', async () => {
      const { service } = await buildService({
        documents: [{ id: 'd1', subtotal: '1000.0000' }],
        costs: [{ orderId: 'o1', cost: '600.0000' }],
      });

      const report = await service.salesMargin(RANGE);

      expect(report.orders[0]!.costStatus).toBe('COMPLETO');
      expect(report.orders[0]!.inTotals).toBe(true);
      expect(report.totals.salesPen).toBe('1000.0000');
      expect(report.totals.partialOrderCount).toBe(0);
      expect(report.totals.excludedOrderCount).toBe(0);
    });

    it('con líneas facturadas sin despachar: PARCIAL, suma igual y el total lo declara', async () => {
      const { service } = await buildService({
        documents: [{ id: 'd1', subtotal: '1000.0000' }],
        costs: [{ orderId: 'o1', cost: '250.0000' }],
        pending: [{ orderId: 'o1', pending: true }],
      });

      const report = await service.salesMargin(RANGE);

      expect(report.orders[0]!.costStatus).toBe('PARCIAL');
      expect(report.orders[0]!.inTotals).toBe(true);
      // El costo es un piso real, no una omisión: se suma, pero el total dice cuántas filas
      // están así para que el margen no se lea como definitivo.
      expect(report.totals.costPen).toBe('250.0000');
      expect(report.totals.partialOrderCount).toBe(1);
    });

    it('con comprobantes fuera del rango y sin despacho declarado: NO_COMPARABLE y fuera de los totales', async () => {
      const { service } = await buildService({
        documents: [{ id: 'd1', subtotal: '400.0000' }],
        outside: [{ orderId: 'o1', count: 1 }],
        // El costo del pedido entero cubre también la venta que quedó fuera del rango.
        costs: [{ orderId: 'o1', invoiceId: null, cost: '700.0000' }],
      });

      const report = await service.salesMargin(RANGE);
      const order = report.orders[0]!;

      expect(order.costStatus).toBe('NO_COMPARABLE');
      expect(order.inTotals).toBe(false);
      expect(order.costPen).toBeNull();
      expect(order.marginPen).toBeNull();
      expect(order.marginPct).toBeNull();
      // La venta se ve, pero no contamina el margen del rango.
      expect(order.salesPen).toBe('400.0000');
      expect(report.totals.salesPen).toBe('0.0000');
      expect(report.totals.costPen).toBe('0.0000');
      expect(report.totals.excludedOrderCount).toBe(1);
      expect(report.totals.excludedSalesPen).toBe('400.0000');
    });

    it('con comprobantes fuera del rango pero todos los del rango declaran su despacho: entra con su porción exacta', async () => {
      const { service } = await buildService({
        documents: [
          { id: 'd1', subtotal: '400.0000' },
          { id: 'd2', subtotal: '100.0000' },
        ],
        outside: [{ orderId: 'o1', count: 1 }],
        costs: [
          { orderId: 'o1', invoiceId: 'd1', cost: '240.0000' },
          { orderId: 'o1', invoiceId: 'd2', cost: '60.0000' },
          // Lo que despachó el comprobante de afuera: existe, y no se cuenta.
          { orderId: 'o1', invoiceId: 'd-fuera', cost: '500.0000' },
        ],
        salesByLine: [
          { documentId: 'd1', line: 'drywall', subtotal: '400.0000' },
          { documentId: 'd2', line: 'drywall', subtotal: '100.0000' },
        ],
      });

      const report = await service.salesMargin(RANGE);
      const order = report.orders[0]!;

      expect(order.costStatus).toBe('COMPLETO');
      expect(order.inTotals).toBe(true);
      // 240 + 60, sin prorratear nada y sin arrastrar los 500 del comprobante de afuera.
      expect(order.costPen).toBe('300.0000');
      expect(order.salesPen).toBe('500.0000');
      expect(order.marginPen).toBe('200.0000');
      // Y los totales por línea tienen que acotarse igual: arrastrar acá los 500 del
      // comprobante de afuera dejaba `totalsByLine` diciendo 800 contra los 300 del total.
      expect(report.totalsByLine[0]!.costPen).toBe('300.0000');
    });

    it('un comprobante sin pedido detrás es comparable consigo mismo', async () => {
      const { service } = await buildService({
        documents: [{ id: 'd1', subtotal: '90.0000', orderId: null, orderSeq: null }],
      });

      const report = await service.salesMargin(RANGE);

      expect(report.orders[0]!.orderCode).toBeNull();
      expect(report.orders[0]!.costStatus).toBe('COMPLETO');
      expect(report.orders[0]!.costPen).toBe('0.0000');
    });
  });

  it('el costo por comprobante solo aparece donde el despacho lo declara', async () => {
    const { service } = await buildService({
      documents: [
        { id: 'd1', subtotal: '400.0000' },
        { id: 'd2', subtotal: '600.0000' },
      ],
      costs: [
        { orderId: 'o1', invoiceId: 'd1', cost: '240.0000' },
        { orderId: 'o1', invoiceId: null, cost: '300.0000' },
      ],
    });

    const report = await service.salesMargin(RANGE);
    const [first, second] = report.orders[0]!.documents;

    expect(first!.costPen).toBe('240.0000');
    expect(first!.marginPen).toBe('160.0000');
    // El segundo no se infiere a partir de lo que sobra: D-205 lo prohíbe explícitamente.
    expect(second!.costPen).toBeNull();
    expect(second!.marginPen).toBeNull();
    // El pedido sí tiene su costo entero: 240 + 300.
    expect(report.orders[0]!.costPen).toBe('540.0000');
  });

  it('las líneas libres del comprobante caen en el grupo sin línea, no en una cualquiera', async () => {
    const { service } = await buildService({
      documents: [{ id: 'd1', subtotal: '1000.0000' }],
      costs: [
        { orderId: 'o1', line: 'drywall', cost: '300.0000' },
        { orderId: 'o1', line: 'metallic-roofing', cost: '200.0000' },
      ],
      salesByLine: [
        { documentId: 'd1', line: 'drywall', subtotal: '600.0000' },
        { documentId: 'd1', line: 'metallic-roofing', subtotal: '350.0000' },
        { documentId: 'd1', line: null, subtotal: '50.0000' },
      ],
    });

    const report = await service.salesMargin(RANGE);

    expect(report.totalsByLine).toEqual([
      {
        businessLine: null,
        salesPen: '50.0000',
        costPen: '0.0000',
        marginPen: '50.0000',
        marginPct: '100.00',
      },
      {
        businessLine: 'drywall',
        salesPen: '600.0000',
        costPen: '300.0000',
        marginPen: '300.0000',
        marginPct: '50.00',
      },
      {
        businessLine: 'metallic-roofing',
        salesPen: '350.0000',
        costPen: '200.0000',
        marginPen: '150.0000',
        marginPct: '42.86',
      },
    ]);
  });

  it('la nota de crédito también resta en el total de su línea', async () => {
    const { service } = await buildService({
      documents: [
        { id: 'd1', subtotal: '1000.0000' },
        { id: 'd2', subtotal: '200.0000', docType: 'NOTA_CREDITO' },
      ],
      salesByLine: [
        { documentId: 'd1', line: 'drywall', subtotal: '1000.0000' },
        { documentId: 'd2', line: 'drywall', subtotal: '200.0000' },
      ],
    });

    const report = await service.salesMargin(RANGE);

    expect(report.totalsByLine[0]!.salesPen).toBe('800.0000');
  });

  it('un pedido que el rango solo ve anularse calla el porcentaje en vez de mostrar +100 %', async () => {
    const { service } = await buildService({
      documents: [{ id: 'd1', subtotal: '500.0000', docType: 'NOTA_CREDITO' }],
      costs: [{ orderId: 'o1', cost: '0.0000' }],
    });

    const report = await service.salesMargin(RANGE);

    expect(report.orders[0]!.salesPen).toBe('-500.0000');
    // (−500 − 0) / −500 = +100 %, que se lee al revés de lo que pasó. El monto sí se muestra.
    expect(report.orders[0]!.marginPct).toBeNull();
    expect(report.orders[0]!.marginPen).toBe('-500.0000');
    expect(report.totals.marginPct).toBeNull();
  });

  it('el total de costo es siempre la suma de los totales por línea, mezclando los tres estados', async () => {
    // La invariante que el reporte no puede romper: quien sume la columna de costo de la
    // tabla por línea tiene que obtener el número grande de arriba. Se comprueba con las tres
    // clases de fila conviviendo, que es cuando de verdad se rompe — con una sola clase, los
    // dos caminos coinciden por casualidad.
    const { service } = await buildService({
      documents: [
        { id: 'd1', subtotal: '1000.0000', orderId: 'o1', orderSeq: 1 },
        { id: 'd2', subtotal: '500.0000', orderId: 'o2', orderSeq: 2 },
        { id: 'd3', subtotal: '400.0000', orderId: 'o3', orderSeq: 3 },
        { id: 'd4', subtotal: '300.0000', orderId: 'o4', orderSeq: 4 },
      ],
      // o3 queda NO_COMPARABLE; o4 tiene comprobantes afuera pero el suyo declara despacho.
      outside: [
        { orderId: 'o3', count: 2 },
        { orderId: 'o4', count: 1 },
      ],
      pending: [{ orderId: 'o2', pending: true }],
      costs: [
        { orderId: 'o1', line: 'drywall', cost: '600.0000' },
        { orderId: 'o1', line: 'metallic-roofing', cost: '100.0000' },
        { orderId: 'o2', line: 'drywall', cost: '120.0000' },
        { orderId: 'o3', line: 'drywall', cost: '900.0000' },
        { orderId: 'o4', invoiceId: 'd4', line: 'trading', cost: '180.0000' },
        { orderId: 'o4', invoiceId: 'd-fuera', line: 'trading', cost: '700.0000' },
      ],
      salesByLine: [
        { documentId: 'd1', line: 'drywall', subtotal: '1000.0000' },
        { documentId: 'd2', line: 'drywall', subtotal: '500.0000' },
        { documentId: 'd3', line: 'drywall', subtotal: '400.0000' },
        { documentId: 'd4', line: 'trading', subtotal: '300.0000' },
      ],
    });

    const report = await service.salesMargin(RANGE);

    const sumOf = (key: 'salesPen' | 'costPen'): string =>
      report.totalsByLine.reduce((acc, t) => acc + Number(t[key]), 0).toFixed(4);

    expect(sumOf('costPen')).toBe(report.totals.costPen);
    expect(sumOf('salesPen')).toBe(report.totals.salesPen);
    // 600 + 100 + 120 + 180: el 900 de o3 no entra porque no es comparable, y el 700 de o4 es
    // del comprobante que quedó fuera del rango.
    expect(report.totals.costPen).toBe('1000.0000');
    expect(report.totals.partialOrderCount).toBe(1);
    expect(report.totals.excludedOrderCount).toBe(1);
    expect(report.totals.excludedSalesPen).toBe('400.0000');
  });

  it('presupuesto de consultas: seis, y el conteo no cambia con diez pedidos y veinte comprobantes', async () => {
    const one = await buildService({
      documents: [{ id: 'd1', subtotal: '10.0000' }],
      costs: [{ orderId: 'o1', cost: '5.0000' }],
    });
    await one.service.salesMargin(RANGE);
    expect(one.calls).toHaveLength(6);

    const many = await buildService({
      documents: Array.from({ length: 20 }, (_, i) => ({
        id: `d${i}`,
        subtotal: '10.0000',
        orderId: `o${i % 10}`,
        orderSeq: i % 10,
      })),
      costs: Array.from({ length: 10 }, (_, i) => ({ orderId: `o${i}`, cost: '5.0000' })),
    });
    const report = await many.service.salesMargin(RANGE);

    expect(many.calls).toHaveLength(6);
    expect(report.orders).toHaveLength(10);
    expect(report.totals.salesPen).toBe('200.0000');
    expect(report.totals.costPen).toBe('50.0000');
  });

  it('un rango vacío no gasta las cinco consultas que dependen de lo que trajo la primera', async () => {
    const { service, calls } = await buildService({ documents: [] });

    const report = await service.salesMargin(RANGE);

    expect(calls).toHaveLength(1);
    expect(report.orders).toEqual([]);
    expect(report.totals.salesPen).toBe('0.0000');
    expect(report.totals.marginPct).toBeNull();
  });

  it('rechaza un rango que termina antes de empezar', () => {
    // La guarda vive en el schema Zod del borde, no en el servicio: el servicio nunca ve un
    // rango invertido porque el pipe lo corta antes.
    expect(salesMarginQuerySchema.safeParse({ from: '2026-09-30', to: '2026-09-01' }).success).toBe(
      false,
    );
    expect(salesMarginQuerySchema.safeParse({ from: '2026-09-01', to: '2026-09-30' }).success).toBe(
      true,
    );
  });
});

/**
 * D-285: un pedido despachado con alguna línea sin salida de kardex (lo «entregado antes del
 * inventario inicial» de D-278) no tiene costo rastreable. Con costo 0 aparecía con margen del
 * 100 %: queda fuera de los totales de margen y se cuenta aparte.
 */
describe('SalesMarginService — costo no rastreable (D-285)', () => {
  it('despachado sin salida de kardex: NO_RASTREABLE, fuera del margen y contado aparte', async () => {
    const { service } = await buildService({
      documents: [
        { id: 'd1', subtotal: '1000.0000', orderId: 'o1' },
        { id: 'd2', subtotal: '500.0000', orderId: 'o2', orderSeq: 2 },
      ],
      costs: [{ orderId: 'o2', cost: '300.0000' }],
      pending: [
        { orderId: 'o1', pending: false, untraceable: true },
        { orderId: 'o2', pending: false },
      ],
    });
    const report = await service.salesMargin({ from: '2026-09-01', to: '2026-09-30' });
    const o1 = report.orders.find((o) => o.salesOrderId === 'o1');
    expect(o1).toMatchObject({ costStatus: 'NO_RASTREABLE', inTotals: false, costPen: null });
    expect(report.totals.salesPen).toBe('500.0000');
    expect(report.totals.costPen).toBe('300.0000');
    expect(report.totals.untraceableOrderCount).toBe(1);
    expect(report.totals.untraceableSalesPen).toBe('1000.0000');
    expect(report.totals.excludedOrderCount).toBe(0);
  });
});

/**
 * cc23 (D-391): ventas y margen por línea. Cada pestaña es la porción de esa línea de los
 * mismos pedidos que suma «Todas»; la suma de las pestañas, más lo que no tiene línea (una
 * línea libre del comprobante), es exactamente «Todas».
 */
describe('SalesMarginService — por línea (cc23)', () => {
  const LINES = ['drywall', 'metallic-roofing', 'roofing', 'services', 'trading'] as const;

  // o1: mixto drywall + Aluzinc + servicio, con una nota de crédito de Aluzinc. o2: reventa,
  // costo parcial. o3: facturación parcial no comparable (Aluzinc). o4: no rastreable (UPVC).
  // d6: venta directa sin pedido, con una línea libre sin producto.
  const seeds: Seeds = {
    documents: [
      { id: 'd1', orderId: 'o1', orderSeq: 1, subtotal: '1500.0000' },
      { id: 'd2', orderId: 'o1', orderSeq: 1, subtotal: '200.0000', docType: 'NOTA_CREDITO' },
      { id: 'd3', orderId: 'o2', orderSeq: 2, subtotal: '800.0000' },
      { id: 'd4', orderId: 'o3', orderSeq: 3, subtotal: '300.0000' },
      { id: 'd5', orderId: 'o4', orderSeq: 4, subtotal: '120.0000' },
      { id: 'd6', orderId: null, orderSeq: null, subtotal: '90.0000' },
    ],
    salesByLine: [
      { documentId: 'd1', line: 'drywall', subtotal: '1000.0000' },
      { documentId: 'd1', line: 'metallic-roofing', subtotal: '400.0000' },
      { documentId: 'd1', line: 'services', subtotal: '100.0000' },
      { documentId: 'd2', line: 'metallic-roofing', subtotal: '200.0000' },
      { documentId: 'd3', line: 'trading', subtotal: '800.0000' },
      { documentId: 'd4', line: 'metallic-roofing', subtotal: '300.0000' },
      { documentId: 'd5', line: 'roofing', subtotal: '120.0000' },
      { documentId: 'd6', line: 'drywall', subtotal: '60.0000' },
      { documentId: 'd6', line: null, subtotal: '30.0000' },
    ],
    costs: [
      { orderId: 'o1', invoiceId: 'd1', line: 'drywall', cost: '700.0000' },
      { orderId: 'o1', invoiceId: 'd1', line: 'metallic-roofing', cost: '250.0000' },
      { orderId: 'o2', invoiceId: null, line: 'trading', cost: '500.0000' },
      { orderId: 'o3', invoiceId: null, line: 'metallic-roofing', cost: '900.0000' },
    ],
    outside: [{ orderId: 'o3', count: 1 }],
    pending: [
      { orderId: 'o1', pending: false },
      { orderId: 'o2', pending: true },
      { orderId: 'o3', pending: false },
      { orderId: 'o4', pending: false, untraceable: true },
    ],
  };

  /** Suma exacta de importes (Decimal), con la escala de dinero. */
  const sum = (values: string[]): string => decimalSum(values).toFixed(4);

  it('las pestañas más lo que no tiene línea suman exactamente «Todas»', async () => {
    const { service } = await buildService(seeds);
    const all = await service.salesMargin(RANGE);
    const tabs = await Promise.all(
      LINES.map((businessLine) => service.salesMargin({ ...RANGE, businessLine })),
    );
    const noLine = all.totalsByLine.find((t) => t.businessLine === null);
    expect(noLine?.salesPen).toBe('30.0000');

    for (const key of ['salesPen', 'marginPen'] as const) {
      expect(sum([...tabs.map((t) => t.totals[key]), noLine!.salesPen])).toBe(all.totals[key]);
    }
    for (const key of ['costPen', 'excludedSalesPen', 'untraceableSalesPen'] as const) {
      expect(sum(tabs.map((t) => t.totals[key]))).toBe(all.totals[key]);
    }
    // `partialOrderCount` no se suma entre pestañas: un pedido mixto con costo parcial cuenta
    // en cada línea que toca (autorrevisión P3-3).
    // Y cada pestaña dice lo mismo que su fila de «Totales por línea» en «Todas».
    for (const [i, line] of LINES.entries()) {
      const row = all.totalsByLine.find((t) => t.businessLine === line);
      const tab = tabs[i]!;
      expect(tab.totalsByLine).toEqual(row === undefined ? [] : [row]);
      expect(tab.totals.salesPen).toBe(row?.salesPen ?? '0.0000');
      expect(tab.totals.costPen).toBe(row?.costPen ?? '0.0000');
    }
  });

  it('el total de «Todas» no cambia con cc23', async () => {
    const { service } = await buildService(seeds);
    const all = await service.salesMargin(RANGE);
    // o1 (1300 − 950) + o2 (800 − 500) + d6 (90 − 0); o3 excluido y o4 no rastreable.
    expect(all.totals).toMatchObject({
      salesPen: '2190.0000',
      costPen: '1450.0000',
      excludedOrderCount: 1,
      excludedSalesPen: '300.0000',
      untraceableOrderCount: 1,
      untraceableSalesPen: '120.0000',
      partialOrderCount: 1,
    });
    expect(all.orders).toHaveLength(5);
  });

  it('la fila de un pedido mixto es su porción de la línea, con sus comprobantes', async () => {
    const { service } = await buildService(seeds);
    const aluzinc = await service.salesMargin({ ...RANGE, businessLine: 'metallic-roofing' });
    const o1 = aluzinc.orders.find((o) => o.salesOrderId === 'o1')!;
    // 400 de la factura menos 200 de la nota de crédito; costo 250 de la salida de Aluzinc.
    expect(o1).toMatchObject({ salesPen: '200.0000', costPen: '250.0000', marginPen: '-50.0000' });
    expect(o1.documents.map((d) => [d.id, d.salesPen, d.costPen])).toEqual([
      ['d1', '400.0000', '250.0000'],
      // La nota de crédito no declara despacho: sin costo propio, como en «Todas».
      ['d2', '-200.0000', null],
    ]);
    // o3 (no comparable) aparece en su pestaña, fuera de los totales, con su venta de la línea.
    expect(aluzinc.orders.find((o) => o.salesOrderId === 'o3')).toMatchObject({
      inTotals: false,
      costPen: null,
      salesPen: '300.0000',
    });
    expect(aluzinc.totals.excludedOrderCount).toBe(1);
  });

  it('un pedido sin nada de la línea no aparece en su pestaña', async () => {
    const { service } = await buildService(seeds);
    const trading = await service.salesMargin({ ...RANGE, businessLine: 'trading' });
    expect(trading.orders.map((o) => o.salesOrderId)).toEqual(['o2']);
    expect(trading.totals.partialOrderCount).toBe(1);
    const roofing = await service.salesMargin({ ...RANGE, businessLine: 'roofing' });
    expect(roofing.orders.map((o) => [o.salesOrderId, o.costStatus])).toEqual([
      ['o4', 'NO_RASTREABLE'],
    ]);
    expect(roofing.totals.untraceableSalesPen).toBe('120.0000');
    expect(roofing.totals.salesPen).toBe('0.0000');
  });

  it('Servicios trae su venta y ningún costo registrado (D-392 se declara en la pantalla)', async () => {
    const { service } = await buildService(seeds);
    const services = await service.salesMargin({ ...RANGE, businessLine: 'services' });
    expect(services.totals.salesPen).toBe('100.0000');
    expect(services.totals.costPen).toBe('0.0000');
  });

  it('una línea fuera de la matriz no pasa la validación', () => {
    expect(salesMarginQuerySchema.safeParse({ ...RANGE, businessLine: 'acero' }).success).toBe(
      false,
    );
    expect(salesMarginQuerySchema.safeParse({ ...RANGE, businessLine: 'services' }).success).toBe(
      true,
    );
  });
});

/**
 * cc24 (D-412): la venta de Servicios no depende del estado de costo del pedido. En un pedido
 * mixto con costo no comparable o no rastreable por otra línea, el servicio suma en su pestaña y
 * en «Todas»; queda fuera solo el resto.
 */
describe('SalesMarginService — Servicios no depende del costo (cc24, D-412)', () => {
  const LINES = ['drywall', 'metallic-roofing', 'roofing', 'services', 'trading'] as const;
  const sum = (values: string[]): string => decimalSum(values).toFixed(4);

  // o1: drywall + servicio, no rastreable. o2: Aluzinc + servicio, no comparable. o3: drywall
  // con costo completo.
  const seeds: Seeds = {
    documents: [
      { id: 'd1', orderId: 'o1', orderSeq: 1, subtotal: '1050.0000' },
      { id: 'd2', orderId: 'o2', orderSeq: 2, subtotal: '330.0000' },
      { id: 'd3', orderId: 'o3', orderSeq: 3, subtotal: '400.0000' },
    ],
    salesByLine: [
      { documentId: 'd1', line: 'drywall', subtotal: '1000.0000' },
      { documentId: 'd1', line: 'services', subtotal: '50.0000' },
      { documentId: 'd2', line: 'metallic-roofing', subtotal: '300.0000' },
      { documentId: 'd2', line: 'services', subtotal: '30.0000' },
      { documentId: 'd3', line: 'drywall', subtotal: '400.0000' },
    ],
    costs: [
      { orderId: 'o2', invoiceId: null, line: 'metallic-roofing', cost: '900.0000' },
      { orderId: 'o3', invoiceId: 'd3', line: 'drywall', cost: '250.0000' },
    ],
    outside: [{ orderId: 'o2', count: 1 }],
    pending: [
      { orderId: 'o1', pending: false, untraceable: true },
      { orderId: 'o2', pending: false },
      { orderId: 'o3', pending: false },
    ],
  };

  it('en la pestaña Servicios el servicio de un pedido no rastreable o no comparable suma', async () => {
    const { service } = await buildService(seeds);
    const services = await service.salesMargin({ ...RANGE, businessLine: 'services' });
    expect(services.totals).toMatchObject({
      salesPen: '80.0000',
      excludedOrderCount: 0,
      excludedSalesPen: '0.0000',
      untraceableOrderCount: 0,
      untraceableSalesPen: '0.0000',
    });
    expect(services.orders.every((o) => o.inTotals)).toBe(true);
  });

  it('un pedido de solo Servicios facturado en dos meses no cuenta como fuera de los totales', async () => {
    const { service } = await buildService({
      documents: [{ id: 'd9', orderId: 'o9', orderSeq: 9, subtotal: '70.0000' }],
      salesByLine: [{ documentId: 'd9', line: 'services', subtotal: '70.0000' }],
      outside: [{ orderId: 'o9', count: 1 }],
      pending: [{ orderId: 'o9', pending: true }],
    });
    const all = await service.salesMargin(RANGE);
    expect(all.orders[0]).toMatchObject({ costStatus: 'NO_COMPARABLE', inTotals: true });
    expect(all.totals).toMatchObject({
      salesPen: '70.0000',
      noCostSalesPen: '70.0000',
      excludedOrderCount: 0,
    });
    // Y en su pestaña, el costo parcial no se cuenta: Servicios no tiene costo que sea un piso.
    const services = await service.salesMargin({ ...RANGE, businessLine: 'services' });
    expect(services.totals.partialOrderCount).toBe(0);
  });

  it('en «Todas» el servicio suma a la venta y a su fila; la venta excluida es solo el resto', async () => {
    const { service } = await buildService(seeds);
    const all = await service.salesMargin(RANGE);
    expect(all.totals).toMatchObject({
      // o3 400 + servicios de o1 (50) y o2 (30).
      salesPen: '480.0000',
      costPen: '250.0000',
      untraceableOrderCount: 1,
      untraceableSalesPen: '1000.0000',
      excludedOrderCount: 1,
      excludedSalesPen: '300.0000',
    });
    expect(all.totalsByLine.find((t) => t.businessLine === 'services')?.salesPen).toBe('80.0000');
  });

  it('las pestañas siguen sumando «Todas»', async () => {
    const { service } = await buildService(seeds);
    const all = await service.salesMargin(RANGE);
    const tabs = await Promise.all(
      LINES.map((businessLine) => service.salesMargin({ ...RANGE, businessLine })),
    );
    for (const key of ['salesPen', 'costPen', 'excludedSalesPen', 'untraceableSalesPen'] as const) {
      expect(sum(tabs.map((t) => t.totals[key]))).toBe(all.totals[key]);
    }
  });
});

describe('SalesMarginService — costo del comprobante en la pestaña de una línea (cc24, P3-4)', () => {
  it('un comprobante que solo declara el despacho de otra línea no muestra costo 0', async () => {
    const { service } = await buildService({
      documents: [{ id: 'd1', orderId: 'o1', subtotal: '1500.0000' }],
      salesByLine: [
        { documentId: 'd1', line: 'drywall', subtotal: '1000.0000' },
        { documentId: 'd1', line: 'roofing', subtotal: '500.0000' },
      ],
      costs: [{ orderId: 'o1', invoiceId: 'd1', line: 'drywall', cost: '600.0000' }],
      pending: [{ orderId: 'o1', pending: true }],
    });
    const roofing = await service.salesMargin({ ...RANGE, businessLine: 'roofing' });
    expect(roofing.orders[0]?.documents[0]).toMatchObject({
      salesPen: '500.0000',
      costPen: null,
      marginPen: null,
      marginPct: null,
    });
    const drywall = await service.salesMargin({ ...RANGE, businessLine: 'drywall' });
    expect(drywall.orders[0]?.documents[0]).toMatchObject({ costPen: '600.0000' });
  });
});

/**
 * cc24 (D-409): en «Todas», el margen se calcula sin Servicios. La venta de Servicios sigue
 * sumando al total y se informa aparte (`noCostSalesPen`); el costo no cambia.
 */
describe('SalesMarginService — margen sin Servicios (cc24, D-409)', () => {
  const LINES = ['drywall', 'metallic-roofing', 'roofing', 'services', 'trading'] as const;
  const sum = (values: string[]): string => decimalSum(values).toFixed(4);

  // o1: drywall 1000 (costo 600) + servicio 100. o2: solo servicio 50. o3: UPVC 400 (costo 300).
  const seeds: Seeds = {
    documents: [
      { id: 'd1', orderId: 'o1', orderSeq: 1, subtotal: '1100.0000' },
      { id: 'd2', orderId: 'o2', orderSeq: 2, subtotal: '50.0000' },
      { id: 'd3', orderId: 'o3', orderSeq: 3, subtotal: '400.0000' },
    ],
    salesByLine: [
      { documentId: 'd1', line: 'drywall', subtotal: '1000.0000' },
      { documentId: 'd1', line: 'services', subtotal: '100.0000' },
      { documentId: 'd2', line: 'services', subtotal: '50.0000' },
      { documentId: 'd3', line: 'roofing', subtotal: '400.0000' },
    ],
    costs: [
      { orderId: 'o1', invoiceId: 'd1', line: 'drywall', cost: '600.0000' },
      { orderId: 'o3', invoiceId: 'd3', line: 'roofing', cost: '300.0000' },
    ],
    pending: [
      { orderId: 'o1', pending: false },
      { orderId: 'o2', pending: false },
      { orderId: 'o3', pending: false },
    ],
  };

  it('«Todas»: la venta incluye Servicios y el margen no', async () => {
    const { service } = await buildService(seeds);
    const all = await service.salesMargin(RANGE);
    expect(all.totals).toMatchObject({
      salesPen: '1550.0000',
      noCostSalesPen: '150.0000',
      costPen: '900.0000',
      // (1550 − 150) − 900 = 500, sobre 1400.
      marginPen: '500.0000',
      marginPct: '35.71',
    });
  });

  it('la pestaña de Servicios no tiene margen; las demás no tienen venta sin costo', async () => {
    const { service } = await buildService(seeds);
    const services = await service.salesMargin({ ...RANGE, businessLine: 'services' });
    expect(services.totals).toMatchObject({
      salesPen: '150.0000',
      noCostSalesPen: '150.0000',
      costPen: '0.0000',
      marginPen: '0.0000',
      marginPct: null,
    });
    const drywall = await service.salesMargin({ ...RANGE, businessLine: 'drywall' });
    expect(drywall.totals).toMatchObject({
      salesPen: '1000.0000',
      noCostSalesPen: '0.0000',
      marginPen: '400.0000',
      marginPct: '40.00',
    });
  });

  it('la venta de las pestañas suma «Todas»; el margen de «Todas» es el de las líneas con costo', async () => {
    const { service } = await buildService(seeds);
    const all = await service.salesMargin(RANGE);
    const tabs = await Promise.all(
      LINES.map((businessLine) => service.salesMargin({ ...RANGE, businessLine })),
    );
    for (const key of ['salesPen', 'noCostSalesPen', 'costPen', 'marginPen'] as const) {
      expect(sum(tabs.map((t) => t.totals[key]))).toBe(all.totals[key]);
    }
    // Servicios no aporta margen: el de «Todas» es la suma del de las líneas con costo.
    const withCost = all.totalsByLine.filter((t) => t.businessLine !== 'services');
    expect(sum(withCost.map((t) => t.marginPen))).toBe(all.totals.marginPen);
  });
});
