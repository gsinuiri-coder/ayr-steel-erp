import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { salesMarginQuerySchema } from '@ayr/shared';
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
  pending?: { orderId: string; pending: boolean }[];
}

async function buildService(
  seeds: Seeds,
): Promise<{ service: SalesMarginService; calls: string[] }> {
  const calls: string[] = [];
  const queryRaw = jest.fn((strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    calls.push(sql);
    if (sql.includes('BOOL_OR')) {
      return Promise.resolve(
        (seeds.pending ?? []).map((p) => ({ sales_order_id: p.orderId, pending: p.pending })),
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

  return { service: module.get(SalesMarginService), calls };
}

describe('SalesMarginService', () => {
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
