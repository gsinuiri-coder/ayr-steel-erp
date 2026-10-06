import { FiscalDocType, FiscalDocumentStatus, PaymentTerms, Prisma } from '@prisma/client';
import { agingBucket, Decimal } from '@ayr/shared';
import type { AuditService } from '../audit/audit.service';
import type { OperationDateService } from '../common/operation-date.service';
import { loadCollectibleDocuments } from '../invoicing/collectible-documents';
import { ReceivablesService } from '../invoicing/receivables.service';
import type { PrismaService } from '../prisma/prisma.service';
import { assembleReceivablesAging } from './receivables-aging';
import { ReceivablesAgingService } from './receivables-aging.service';

/**
 * cc25 (D-421..D-423, D-428, D-432). El reporte de cuentas por cobrar lee los saldos con la
 * misma lectura que cobranzas: lo que se fija acá es que los dos dicen el mismo número para los
 * mismos comprobantes, y que el reporte no hace una consulta por fila.
 */

const D = (v: string) => new Prisma.Decimal(v);
const date = (v: string) => new Date(`${v}T00:00:00.000Z`);

const CUSTOMER_A = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Cliente A',
  docNumber: '20100000001',
};
const CUSTOMER_B = {
  id: '00000000-0000-4000-8000-0000000000b1',
  name: 'Cliente B',
  docNumber: '20100000002',
};
const SELLER_1 = '00000000-0000-4000-8000-000000000051';
const SELLER_2 = '00000000-0000-4000-8000-000000000052';
const ISSUER = '00000000-0000-4000-8000-000000000099';

let seq = 0;
function doc(over: {
  customer?: typeof CUSTOMER_A;
  status?: FiscalDocumentStatus;
  total: string;
  issueDate?: string;
  dueDate?: string | null;
  paid?: { amount: string; reversed?: boolean }[];
  credited?: string[];
  sellerId?: string | null;
  viaDispatch?: boolean;
  createdById?: string;
}) {
  seq += 1;
  const customer = over.customer ?? CUSTOMER_A;
  const order =
    over.sellerId === undefined
      ? null
      : {
          id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
          seq,
          sellerId: over.sellerId,
        };
  return {
    id: `00000000-0000-4000-9000-${String(seq).padStart(12, '0')}`,
    docType: FiscalDocType.FACTURA,
    status: over.status ?? FiscalDocumentStatus.ACCEPTED,
    number: `F001-${String(seq).padStart(8, '0')}`,
    customerId: customer.id,
    customer,
    issueDate: date(over.issueDate ?? '2026-09-01'),
    dueDate: over.dueDate === undefined || over.dueDate === null ? null : date(over.dueDate),
    paymentTerms:
      over.dueDate === undefined || over.dueDate === null
        ? PaymentTerms.CONTADO
        : PaymentTerms.CREDITO,
    totalPen: D(over.total),
    createdById: over.createdById ?? ISSUER,
    payments: (over.paid ?? []).map((p) => ({
      amountPen: D(p.amount),
      reversedAt: p.reversed ? new Date() : null,
    })),
    creditNotes: (over.credited ?? []).map((t) => ({ totalPen: D(t) })),
    salesOrder: over.viaDispatch ? null : order,
    dispatch: over.viaDispatch ? { salesOrder: order } : null,
  };
}

function prismaWith(documents: ReturnType<typeof doc>[]) {
  const fiscalDocument = { findMany: jest.fn().mockResolvedValue(documents) };
  const user = {
    findMany: jest.fn().mockResolvedValue([
      { id: SELLER_1, name: 'Vendedora Uno' },
      { id: SELLER_2, name: 'Vendedor Dos' },
      { id: ISSUER, name: 'Caja' },
    ]),
  };
  return { fiscalDocument, user } as unknown as PrismaService & {
    fiscalDocument: { findMany: jest.Mock };
    user: { findMany: jest.Mock };
  };
}

function receivablesOf(prisma: PrismaService) {
  return new ReceivablesService(
    prisma,
    {} as unknown as AuditService,
    {} as unknown as OperationDateService,
  );
}

/** Una cartera con los casos que cambian el saldo: cobros, reversas, NC, céntimos, anulados. */
function portfolio() {
  return [
    doc({
      total: '1180.0000',
      dueDate: '2026-09-30',
      paid: [{ amount: '180.00' }],
      sellerId: SELLER_1,
    }),
    // Un cobro revertido vuelve al saldo.
    doc({
      total: '500.0000',
      dueDate: '2026-08-15',
      paid: [{ amount: '500.00', reversed: true }],
      sellerId: SELLER_2,
    }),
    // Nota de crédito viva: resta.
    doc({
      customer: CUSTOMER_B,
      total: '2360.0000',
      dueDate: '2026-06-01',
      credited: ['360.0000'],
      sellerId: SELLER_1,
    }),
    // D-377: un resto de fracciones de céntimo no es deuda.
    doc({
      customer: CUSTOMER_B,
      total: '118.0001',
      paid: [{ amount: '118.00' }],
      sellerId: SELLER_2,
    }),
    // Al contado, sin pedido: el dueño es quien lo emitió (D-432).
    doc({ customer: CUSTOMER_B, total: '59.0050', issueDate: '2026-09-20' }),
    // Pagado entero.
    doc({ total: '100.0000', paid: [{ amount: '100.00' }], sellerId: SELLER_1 }),
    // Anulado: no debe nada aunque la consulta lo trajera.
    doc({ total: '999.0000', status: FiscalDocumentStatus.VOIDED, sellerId: SELLER_1 }),
    // Pedido del despacho (la guía no tiene pedido propio): el vendedor es el de ese pedido.
    doc({ total: '300.0000', dueDate: '2026-11-15', sellerId: SELLER_2, viaDispatch: true }),
  ];
}

describe('ReceivablesAgingService', () => {
  it('el total y el saldo por cliente coinciden con los de cobranzas para los mismos comprobantes', async () => {
    const documents = portfolio();
    const prisma = prismaWith(documents);
    const cobranzasTotals = await receivablesOf(prisma).totals();
    const cobranzasRows = await receivablesOf(prisma).receivables({ page: 1, pageSize: 100 });
    const report = await new ReceivablesAgingService(prisma).report();

    expect(report.totals.balancePen).toBe(cobranzasTotals.totalBalancePen);
    expect(report.totals.customerCount).toBe(cobranzasTotals.customerCount);
    const byCustomer = new Map(report.customers.map((c) => [c.customerId, c]));
    for (const row of cobranzasRows.items) {
      expect(byCustomer.get(row.customerId)?.balancePen).toBe(row.balancePen);
      expect(byCustomer.get(row.customerId)?.documentCount).toBe(row.documentCount);
    }
    // Y los números en sí: 1000 + 500 + 2000 + 59.005 + 300.
    expect(report.totals.balancePen).toBe('3859.0050');
    expect(report.totals.documentCount).toBe(5);
    // La suma de los tramos es el total.
    const bucketsSum = Object.values(report.totals.buckets).reduce(
      (acc, v) => acc.plus(new Decimal(v)),
      new Decimal(0),
    );
    expect(bucketsSum.toFixed(4)).toBe(report.totals.balancePen);
  });

  it('con filtro por vendedor, el total es la suma de los comprobantes de ese vendedor', async () => {
    const prisma = prismaWith(portfolio());
    const service = new ReceivablesAgingService(prisma);
    const all = await service.report();
    const one = await service.report({ sellerId: SELLER_1 });
    const two = await service.report({ sellerId: SELLER_2 });
    const issuer = await service.report({ sellerId: ISSUER });

    expect(one.totals.balancePen).toBe('3000.0000');
    expect(two.totals.balancePen).toBe('800.0000');
    expect(issuer.totals.balancePen).toBe('59.0050');
    expect(
      new Decimal(one.totals.balancePen)
        .plus(two.totals.balancePen)
        .plus(issuer.totals.balancePen)
        .toFixed(4),
    ).toBe(all.totals.balancePen);
    // Las opciones del filtro no dependen del filtro.
    expect(one.sellers).toEqual(all.sellers);
    expect(all.sellers.map((s) => s.name)).toEqual(['Caja', 'Vendedor Dos', 'Vendedora Uno']);
    expect(one.sellerId).toBe(SELLER_1);
  });

  it('dos consultas fijas, sin una por cliente ni por comprobante', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      doc({
        customer: { ...CUSTOMER_A, id: `00000000-0000-4000-8000-1${String(i).padStart(11, '0')}` },
        total: '10.0000',
        sellerId: i % 2 === 0 ? SELLER_1 : SELLER_2,
      }),
    );
    const prisma = prismaWith(many);
    const report = await new ReceivablesAgingService(prisma).report();
    expect(report.customers).toHaveLength(60);
    expect(prisma.fiscalDocument.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  });

  it('la lectura excluye los archivados y solo trae facturas y boletas vivas', async () => {
    const prisma = prismaWith([]);
    await loadCollectibleDocuments(prisma);
    const [[args]] = prisma.fiscalDocument.findMany.mock.calls as [
      [{ where: { archivedAt: unknown; docType: unknown; status: { in: unknown[] } } }],
    ];
    const where = args.where;
    expect(where.archivedAt).toBeNull();
    expect(where.docType).toEqual({ in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] });
    expect(where.status.in).not.toContain(FiscalDocumentStatus.DRAFT);
    expect(where.status.in).not.toContain(FiscalDocumentStatus.VOIDED);
  });
});

describe('assembleReceivablesAging', () => {
  const today = '2026-10-05';

  async function assemble(documents: ReturnType<typeof doc>[]) {
    return assembleReceivablesAging({
      collectible: await loadCollectibleDocuments(prismaWith(documents)),
      sellerNames: new Map([[SELLER_1, 'Vendedora Uno']]),
      sellerId: null,
      today,
    });
  }

  it('los tramos van por fecha de vencimiento (D-422), con los bordes en 0, 30, 60 y 90', () => {
    expect(agingBucket(-3)).toBe('CURRENT');
    expect(agingBucket(0)).toBe('CURRENT');
    expect(agingBucket(1)).toBe('D1_30');
    expect(agingBucket(30)).toBe('D1_30');
    expect(agingBucket(31)).toBe('D31_60');
    expect(agingBucket(60)).toBe('D31_60');
    expect(agingBucket(61)).toBe('D61_90');
    expect(agingBucket(90)).toBe('D61_90');
    expect(agingBucket(91)).toBe('OVER_90');
  });

  it('el contado vence el día de su emisión (D-428) y el crédito, en su fecha', async () => {
    const report = await assemble([
      doc({ total: '10.0000', issueDate: '2026-08-20' }),
      doc({ total: '20.0000', issueDate: '2026-08-20', dueDate: '2026-10-05', sellerId: SELLER_1 }),
      doc({ total: '30.0000', issueDate: '2026-05-01', dueDate: '2026-07-01', sellerId: SELLER_1 }),
    ]);
    const docs = first(report.customers).documents;
    // Del más vencido al que vence más tarde.
    expect(docs.map((d) => [d.paymentTerms, d.agingDate, d.daysOverdue, d.bucket])).toEqual([
      ['CREDITO', '2026-07-01', 96, 'OVER_90'],
      ['CONTADO', '2026-08-20', 46, 'D31_60'],
      ['CREDITO', '2026-10-05', 0, 'CURRENT'],
    ]);
    expect(docs[1]?.dueDate).toBeNull();
    expect(report.totals.buckets).toEqual({
      CURRENT: '20.0000',
      D1_30: '0.0000',
      D31_60: '10.0000',
      D61_90: '0.0000',
      OVER_90: '30.0000',
    });
    expect(first(report.customers).buckets).toEqual(report.totals.buckets);
  });

  it('el detalle declara cobrado, acreditado, pedido y vendedor', async () => {
    const report = await assemble([
      doc({
        total: '1180.0000',
        dueDate: '2026-09-30',
        paid: [{ amount: '100.00' }, { amount: '50.00', reversed: true }],
        credited: ['80.0000'],
        sellerId: SELLER_1,
      }),
    ]);
    const d = first(first(report.customers).documents);
    expect(d).toMatchObject({
      totalPen: '1180.0000',
      paidPen: '100.0000',
      creditedPen: '80.0000',
      balancePen: '1000.0000',
      sellerId: SELLER_1,
      sellerName: 'Vendedora Uno',
    });
    expect(d.salesOrderCode).toMatch(/^PED-\d{6}$/);
    expect(d.salesOrderId).not.toBeNull();
  });

  it('un saldo de medio céntimo o más es deuda; uno menor, no (D-421, D-377)', async () => {
    const report = await assemble([
      doc({ total: '10.0050', paid: [{ amount: '10.00' }] }),
      doc({ total: '10.0049', paid: [{ amount: '10.00' }] }),
    ]);
    expect(report.totals.documentCount).toBe(1);
    expect(report.totals.balancePen).toBe('0.0050');
  });

  it('sin comprobantes con saldo, el reporte está vacío y en cero', async () => {
    const report = await assemble([doc({ total: '5.0000', paid: [{ amount: '5.00' }] })]);
    expect(report.customers).toEqual([]);
    expect(report.sellers).toEqual([]);
    expect(report.totals.balancePen).toBe('0.0000');
  });
});

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('lista vacía');
  return item;
}
