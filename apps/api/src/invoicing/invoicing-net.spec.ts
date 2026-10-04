import {
  FiscalDocType,
  FiscalDocumentStatus,
  Prisma,
  Role,
  type SalesOrderStatus,
} from '@prisma/client';
import { LIVE_DOCUMENT_STATUSES } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { InvoicingService } from './invoicing.service';
import { invoicedByOrderItem } from './invoicing-net';
import { netInvoicedByItem, type ItemSumRow } from './invoicing-math';

/**
 * D-346 (deuda de D-223): lo facturado por línea de pedido es **emitido vivo − acreditado por
 * notas de crédito vivas**. La resta pura se prueba sin base; el resto contra un `tx` en
 * memoria que evalúa los mismos filtros que Prisma (estado, tipo, archivado, documento propio),
 * para que el test falle si la consulta deja de descontar o cuenta una NC que no debe.
 */

const D = (v: string) => new Prisma.Decimal(v);

// ---------------------------------------------------------------------------
// Base en memoria
// ---------------------------------------------------------------------------

interface Row {
  salesOrderItemId: string | null;
  qty: string;
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
  documentId: string;
  document: {
    status: FiscalDocumentStatus;
    docType: FiscalDocType;
    archivedAt: Date | null;
  };
}

interface Where {
  salesOrderItemId?: { in: string[] };
  documentId?: { not: string };
  document?: {
    status?: FiscalDocumentStatus | { in: FiscalDocumentStatus[] };
    docType?: FiscalDocType | { not: FiscalDocType };
    archivedAt?: null;
  };
}

function matches(row: Row, where: Where): boolean {
  if (where.salesOrderItemId && !where.salesOrderItemId.in.includes(row.salesOrderItemId ?? '')) {
    return false;
  }
  if (row.documentId === where.documentId?.not) return false;
  const d = where.document;
  if (!d) return true;
  if (d.status !== undefined) {
    const ok =
      typeof d.status === 'string'
        ? row.document.status === d.status
        : d.status.in.includes(row.document.status);
    if (!ok) return false;
  }
  if (d.docType !== undefined) {
    const ok =
      typeof d.docType === 'string'
        ? row.document.docType === d.docType
        : row.document.docType !== d.docType.not;
    if (!ok) return false;
  }
  if (d.archivedAt === null && row.document.archivedAt !== null) return false;
  return true;
}

/** `groupBy` por `salesOrderItemId` que suma qty e importes de las filas que cumplen el filtro. */
function fakeClient(rows: Row[]) {
  const groupBy = jest.fn(({ where }: { where: Where }) => {
    const sums = new Map<
      string,
      Record<'qty' | 'subtotalPen' | 'igvPen' | 'totalPen', Prisma.Decimal>
    >();
    for (const row of rows.filter((r) => matches(r, where))) {
      const key = row.salesOrderItemId ?? '';
      const acc = sums.get(key) ?? {
        qty: D('0'),
        subtotalPen: D('0'),
        igvPen: D('0'),
        totalPen: D('0'),
      };
      sums.set(key, {
        qty: acc.qty.plus(row.qty),
        subtotalPen: acc.subtotalPen.plus(row.subtotalPen),
        igvPen: acc.igvPen.plus(row.igvPen),
        totalPen: acc.totalPen.plus(row.totalPen),
      });
    }
    return Promise.resolve(
      [...sums].map(([salesOrderItemId, _sum]) => ({ salesOrderItemId, _sum })),
    );
  });
  return {
    fiscalDocumentItem: { groupBy } as unknown as Prisma.TransactionClient['fiscalDocumentItem'],
    groupBy,
  };
}

let docSeq = 0;
function row(
  docType: FiscalDocType,
  status: FiscalDocumentStatus,
  qty: string,
  amounts: { subtotalPen: string; igvPen: string; totalPen: string },
  extra: { archivedAt?: Date; documentId?: string; itemId?: string } = {},
): Row {
  docSeq += 1;
  return {
    salesOrderItemId: extra.itemId ?? 'line-1',
    qty,
    ...amounts,
    documentId: extra.documentId ?? `doc-${docSeq}`,
    document: { status, docType, archivedAt: extra.archivedAt ?? null },
  };
}

const ACCEPTED = FiscalDocumentStatus.ACCEPTED;

// Línea de pedido: 100 unidades a 10.00 + IGV.
const LINE = { subtotalPen: '1000.0000', igvPen: '180.0000', totalPen: '1180.0000' };
const invoice = (qty = '100', amounts = LINE, status: FiscalDocumentStatus = ACCEPTED) =>
  row(FiscalDocType.FACTURA, status, qty, amounts);
const creditNote = (
  qty: string,
  amounts: { subtotalPen: string; igvPen: string; totalPen: string },
  status: FiscalDocumentStatus = ACCEPTED,
) => row(FiscalDocType.NOTA_CREDITO, status, qty, amounts);
const FORTY = { subtotalPen: '400.0000', igvPen: '72.0000', totalPen: '472.0000' };

// ---------------------------------------------------------------------------
// Resta pura
// ---------------------------------------------------------------------------

const sumRow = (
  id: string | null,
  qty: string,
  a: { subtotalPen: string; igvPen: string; totalPen: string },
): ItemSumRow => ({
  salesOrderItemId: id,
  _sum: {
    qty: D(qty),
    subtotalPen: D(a.subtotalPen),
    igvPen: D(a.igvPen),
    totalPen: D(a.totalPen),
  },
});

describe('netInvoicedByItem — la resta pura de emitido y acreditado (D-346)', () => {
  it('sin notas de crédito, lo facturado es lo emitido', () => {
    const net = netInvoicedByItem([sumRow('l-1', '100', LINE)], []);
    expect(net.get('l-1')!.qty.toFixed(3)).toBe('100.000');
    expect(net.get('l-1')!.totalPen.toFixed(4)).toBe('1180.0000');
  });

  it('resta cantidad e importes de la nota de crédito de la misma línea', () => {
    const net = netInvoicedByItem([sumRow('l-1', '100', LINE)], [sumRow('l-1', '40', FORTY)]);
    const n = net.get('l-1')!;
    expect(n.qty.toFixed(3)).toBe('60.000');
    expect(n.subtotalPen.toFixed(4)).toBe('600.0000');
    expect(n.igvPen.toFixed(4)).toBe('108.0000');
    expect(n.totalPen.toFixed(4)).toBe('708.0000');
  });

  it('una nota de otra línea no toca a esta', () => {
    const net = netInvoicedByItem([sumRow('l-1', '100', LINE)], [sumRow('l-2', '40', FORTY)]);
    expect(net.get('l-1')!.qty.toFixed(3)).toBe('100.000');
  });

  it('acreditar más de lo emitido no deja el neto negativo: se acota a cero', () => {
    const net = netInvoicedByItem([sumRow('l-1', '10', FORTY)], [sumRow('l-1', '40', LINE)]);
    const n = net.get('l-1')!;
    expect(n.qty.isZero()).toBe(true);
    expect(n.subtotalPen.isZero()).toBe(true);
    expect(n.igvPen.isZero()).toBe(true);
    expect(n.totalPen.isZero()).toBe(true);
  });

  it('con cantidad neta cero, un residuo de importes también queda en cero', () => {
    // Lo emitido en dos partes recalculadas suma 0.0001 más que lo acreditado por el total.
    const net = netInvoicedByItem(
      [
        sumRow('l-1', '100', {
          subtotalPen: '1000.0001',
          igvPen: '180.0000',
          totalPen: '1180.0001',
        }),
      ],
      [sumRow('l-1', '100', LINE)],
    );
    const n = net.get('l-1')!;
    expect(n.qty.isZero()).toBe(true);
    expect(n.subtotalPen.isZero()).toBe(true);
    expect(n.totalPen.isZero()).toBe(true);
  });

  it('el importe neto tampoco baja de cero aunque la cantidad sí sobre', () => {
    const net = netInvoicedByItem(
      [sumRow('l-1', '100', LINE)],
      [
        sumRow('l-1', '40', {
          subtotalPen: '1000.0001',
          igvPen: '181.0000',
          totalPen: '1181.0000',
        }),
      ],
    );
    const n = net.get('l-1')!;
    expect(n.qty.toFixed(3)).toBe('60.000');
    expect(n.subtotalPen.isZero()).toBe(true);
    expect(n.igvPen.isZero()).toBe(true);
    expect(n.totalPen.isZero()).toBe(true);
  });

  it('las filas sin línea de pedido se ignoran y lo acreditado sin emitido no genera fila', () => {
    const net = netInvoicedByItem(
      [sumRow(null, '5', FORTY)],
      [sumRow('l-9', '5', FORTY), sumRow(null, '1', FORTY)],
    );
    expect(net.size).toBe(0);
  });

  it('acepta agregados con campos nulos como cero', () => {
    const net = netInvoicedByItem(
      [
        {
          salesOrderItemId: 'l-1',
          _sum: { qty: D('5'), subtotalPen: null, igvPen: null, totalPen: null },
        },
      ],
      [
        {
          salesOrderItemId: 'l-1',
          _sum: { qty: null, subtotalPen: null, igvPen: null, totalPen: null },
        },
      ],
    );
    expect(net.get('l-1')!.qty.toFixed(3)).toBe('5.000');
    expect(net.get('l-1')!.totalPen.isZero()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// La función única contra la base en memoria
// ---------------------------------------------------------------------------

describe('invoicedByOrderItem — la función única (D-346)', () => {
  it('sin líneas no consulta nada', async () => {
    const client = fakeClient([]);
    const out = await invoicedByOrderItem(client, []);
    expect(out.size).toBe(0);
    expect(client.groupBy).not.toHaveBeenCalled();
  });

  it('descuenta la nota de crédito viva de la línea, con cantidad e importes', async () => {
    const client = fakeClient([invoice(), creditNote('40', FORTY)]);
    const net = (await invoicedByOrderItem(client, ['line-1'])).get('line-1')!;
    expect(net.qty.toFixed(3)).toBe('60.000');
    expect(net.totalPen.toFixed(4)).toBe('708.0000');
  });

  it.each([
    ['en borrador', FiscalDocumentStatus.DRAFT],
    ['anulada', FiscalDocumentStatus.VOIDED],
    ['rechazada', FiscalDocumentStatus.REJECTED],
    ['anulada por dentro', FiscalDocumentStatus.ANNULLED],
  ])('una nota de crédito %s no acredita', async (_label, status) => {
    const client = fakeClient([invoice(), creditNote('40', FORTY, status)]);
    const net = (await invoicedByOrderItem(client, ['line-1'])).get('line-1')!;
    expect(net.qty.toFixed(3)).toBe('100.000');
  });

  it('una nota de crédito archivada no acredita', async () => {
    const archived = {
      ...creditNote('40', FORTY),
      document: { ...creditNote('40', FORTY).document, archivedAt: new Date() },
    };
    const client = fakeClient([invoice(), archived]);
    const net = (await invoicedByOrderItem(client, ['line-1'])).get('line-1')!;
    expect(net.qty.toFixed(3)).toBe('100.000');
  });

  it.each(LIVE_DOCUMENT_STATUSES)('una nota de crédito %s cuenta como viva', async (status) => {
    const client = fakeClient([invoice(), creditNote('40', FORTY, status)]);
    const net = (await invoicedByOrderItem(client, ['line-1'])).get('line-1')!;
    expect(net.qty.toFixed(3)).toBe('60.000');
  });

  it('un comprobante en borrador o anulado no cuenta como emitido', async () => {
    const client = fakeClient([
      invoice('100', LINE, FiscalDocumentStatus.DRAFT),
      invoice('100', LINE, FiscalDocumentStatus.VOIDED),
    ]);
    expect((await invoicedByOrderItem(client, ['line-1'])).size).toBe(0);
  });

  it('excludeDocumentId no cuenta al documento que pregunta', async () => {
    const own = row(FiscalDocType.FACTURA, ACCEPTED, '30', FORTY, { documentId: 'self' });
    const client = fakeClient([invoice('50', LINE), own]);
    const net = await invoicedByOrderItem(client, ['line-1'], { excludeDocumentId: 'self' });
    expect(net.get('line-1')!.qty.toFixed(3)).toBe('50.000');
  });
});

// ---------------------------------------------------------------------------
// Los sitios que la usan
// ---------------------------------------------------------------------------

const ACTOR: RequestUser = {
  id: 'actor-1',
  email: 'admin@ayr.test',
  name: 'Admin',
  role: Role.ADMINISTRADOR,
  mustChangePassword: false,
  sessionId: 'session-1',
};

const orderItem = {
  id: 'line-1',
  lineNumber: 1,
  qty: D('100'),
  subtotalPen: D(LINE.subtotalPen),
  igvPen: D(LINE.igvPen),
  totalPen: D(LINE.totalPen),
  productId: 'p-1',
  description: 'PLANCHA',
  unit: 'UND',
  product: { sku: 'PLA-1' },
  salesOrder: { id: 'o-1', status: 'CONFIRMED' as SalesOrderStatus, seq: 7, customerId: 'c-1' },
};

interface Resolved {
  qty: string;
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
}

async function resolve(rows: Row[], qty: string, order = orderItem): Promise<Resolved[]> {
  const service = Object.create(InvoicingService.prototype) as {
    resolveLines: (tx: unknown, input: unknown) => Promise<Resolved[]>;
  };
  const client = fakeClient(rows);
  const tx = {
    salesOrderItem: { findMany: jest.fn().mockResolvedValue([order]) },
    fiscalDocumentItem: client.fiscalDocumentItem,
  };
  return service.resolveLines(tx, {
    salesOrderId: 'o-1',
    customerId: 'c-1',
    items: [{ salesOrderItemId: 'line-1', qty }],
  });
}

describe('guard de facturación (resolveLines) con notas de crédito — D-346', () => {
  it('(a) NC parcial: se puede facturar de nuevo hasta lo acreditado', async () => {
    const [line] = await resolve([invoice(), creditNote('40', FORTY)], '40.000');
    expect(line!.qty).toBe('40.000');
  });

  it('(a) NC parcial: y no más de lo acreditado', async () => {
    await expect(resolve([invoice(), creditNote('40', FORTY)], '41.000')).rejects.toThrow(
      'le quedan 40.000 por facturar y se intentan facturar 41.000',
    );
  });

  it('sin nota de crédito, la línea ya facturada por completo sigue frenando', async () => {
    await expect(resolve([invoice()], '1.000')).rejects.toThrow('le quedan 0.000 por facturar');
  });

  it('(b) NC total: la línea vuelve a estar pendiente completa, y copia su importe', async () => {
    const [line] = await resolve([invoice(), creditNote('100', LINE)], '100.000');
    expect(line).toMatchObject({ qty: '100.000', ...LINE });
  });

  it('(b) NC total: no deja facturar más que la línea', async () => {
    await expect(resolve([invoice(), creditNote('100', LINE)], '101.000')).rejects.toThrow(
      'le quedan 100.000 por facturar',
    );
  });

  it.each([
    ['en borrador', FiscalDocumentStatus.DRAFT],
    ['anulada', FiscalDocumentStatus.VOIDED],
    ['rechazada', FiscalDocumentStatus.REJECTED],
  ])('(c) NC %s: no cuenta y se sigue frenando', async (_label, status) => {
    await expect(resolve([invoice(), creditNote('40', FORTY, status)], '1.000')).rejects.toThrow(
      'le quedan 0.000 por facturar',
    );
  });

  it('(c) NC viva más otra anulada: solo descuenta la viva', async () => {
    const rows = [
      invoice(),
      creditNote('40', FORTY),
      creditNote('30', FORTY, FiscalDocumentStatus.VOIDED),
    ];
    await expect(resolve(rows, '41.000')).rejects.toThrow('le quedan 40.000');
    const [line] = await resolve(rows, '40.000');
    expect(line!.qty).toBe('40.000');
  });

  it('(d) la parte que cierra la línea después de una NC toma el resto de cantidad e importes', async () => {
    // FFA1-1350 (D-265): 4 194 kg por 12 439.83 / 2 239.17 / 14 679.00, emitida en dos mitades;
    // la segunda mitad (el resto) se acreditó. Queda facturada la primera: 2 097 kg recalculados.
    const stored = { subtotalPen: '12439.8300', igvPen: '2239.1700', totalPen: '14679.0000' };
    const half = { subtotalPen: '6219.9150', igvPen: '1119.5847', totalPen: '7339.4997' };
    const rest = { subtotalPen: '6219.9150', igvPen: '1119.5853', totalPen: '7339.5003' };
    const line = {
      ...orderItem,
      qty: D('4194'),
      subtotalPen: D(stored.subtotalPen),
      igvPen: D(stored.igvPen),
      totalPen: D(stored.totalPen),
    };
    const rows = [invoice('2097', half), invoice('2097', rest), creditNote('2097', rest)];
    const [closing] = await resolve(rows, '2097.000', line);
    // Cierra con el resto contra lo **neto** (la primera mitad), no contra lo emitido bruto
    // (que dejaría 0) ni contra el recálculo (7 339.4997): las dos mitades suman el papel.
    expect(closing).toMatchObject({ qty: '2097.000', ...rest });
    expect(D(closing!.totalPen).plus(half.totalPen).toFixed(4)).toBe(stored.totalPen);
    expect(D(closing!.igvPen).plus(half.igvPen).toFixed(4)).toBe(stored.igvPen);
    expect(D(closing!.subtotalPen).plus(half.subtotalPen).toFixed(4)).toBe(stored.subtotalPen);
  });

  it('(d) sin la NC, esa misma parte ya no cabe: el neto es lo que abre el cupo', async () => {
    const half = { subtotalPen: '6219.9150', igvPen: '1119.5847', totalPen: '7339.4997' };
    const line = { ...orderItem, qty: D('4194') };
    await expect(
      resolve([invoice('4194', LINE), invoice('2097', half)], '2097.000', line),
    ).rejects.toThrow('le quedan');
  });

  it('(d) una parte que no cierra, tras una NC parcial, se recalcula desde el unitario', async () => {
    const [line] = await resolve([invoice(), creditNote('40', FORTY)], '20.000');
    expect(line).toMatchObject({
      qty: '20.000',
      subtotalPen: '200.0000',
      igvPen: '36.0000',
      totalPen: '236.0000',
    });
  });

  it('(d) el cierre tras una NC parcial coincide con lo acreditado', async () => {
    const [line] = await resolve([invoice(), creditNote('40', FORTY)], '40.000');
    expect(line).toMatchObject({ qty: '40.000', ...FORTY });
  });
});

describe('orderProgress y la reválida al emitir usan la misma función — D-346 (e)', () => {
  function progressService(rows: Row[]) {
    const client = fakeClient(rows);
    const service = Object.create(InvoicingService.prototype) as InvoicingService;
    Object.assign(service, {
      prisma: {
        salesOrder: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'o-1',
            seq: 7,
            status: 'CONFIRMED',
            customerId: 'c-1',
            sellerId: ACTOR.id,
            customer: { name: 'ACME' },
            items: [
              {
                id: 'line-1',
                lineNumber: 1,
                productId: 'p-1',
                description: 'PLANCHA',
                qty: D('100'),
                unit: 'UND',
                unitPricePen: D('10'),
                reserveItemType: 'PRODUCT',
                reserveItemId: 'p-1',
                reserveQty: D('100'),
                reserveUnit: 'UND',
                product: {
                  sku: 'PLA-1',
                  unit: 'UND',
                  thicknessMm: null,
                  widthMm: null,
                  lengthMm: null,
                  pieceWeightKg: null,
                  finish: null,
                },
              },
            ],
          }),
        },
        dispatchItem: { groupBy: jest.fn().mockResolvedValue([]) },
        fiscalDocumentItem: client.fiscalDocumentItem,
      },
      itemLabels: jest.fn().mockResolvedValue(new Map()),
    });
    return { service, client };
  }

  it('orderProgress descuenta la NC viva del pendiente de facturar', async () => {
    const { service } = progressService([invoice(), creditNote('40', FORTY)]);
    const progress = await service.orderProgress(ACTOR, 'o-1');
    expect(progress.lines[0]).toMatchObject({
      invoicedQty: '60.000',
      pendingInvoiceQty: '40.000',
    });
  });

  it('orderProgress no descuenta una NC anulada ni en borrador', async () => {
    const { service } = progressService([
      invoice(),
      creditNote('40', FORTY, FiscalDocumentStatus.VOIDED),
      creditNote('10', FORTY, FiscalDocumentStatus.DRAFT),
    ]);
    const progress = await service.orderProgress(ACTOR, 'o-1');
    expect(progress.lines[0]).toMatchObject({ invoicedQty: '100.000', pendingInvoiceQty: '0.000' });
  });

  it('orderProgress y resolveLines dan el mismo pendiente para las mismas filas', async () => {
    const rows = [invoice(), creditNote('40', FORTY)];
    const { service, client } = progressService(rows);
    const progress = await service.orderProgress(ACTOR, 'o-1');
    const pending = progress.lines[0]!.pendingInvoiceQty;
    // El guard acepta exactamente el pendiente que la pantalla ofrece, y ni un poco más.
    const [ok] = await resolve(rows, pending);
    expect(ok!.qty).toBe(pending);
    await expect(resolve(rows, '40.001')).rejects.toThrow('le quedan 40.000');
    // Cada sitio hace exactamente las dos consultas de la función única (emitido y acreditado).
    expect(client.groupBy).toHaveBeenCalledTimes(2);
  });

  describe('assertStillAvailable (reválida al emitir)', () => {
    type Assert = (tx: unknown, doc: unknown) => Promise<void>;
    const draftItem = (qty: string) => ({
      qty: D(qty),
      salesOrderItemId: 'line-1',
      affectedItemId: null,
    });
    async function reassert(rows: Row[], qty: string, orderStatus = 'CONFIRMED') {
      const service = Object.create(InvoicingService.prototype) as { assertStillAvailable: Assert };
      const client = fakeClient(rows);
      const tx = {
        salesOrderItem: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'line-1',
              lineNumber: 1,
              qty: D('100'),
              salesOrder: { seq: 1, status: orderStatus },
            },
          ]),
        },
        fiscalDocumentItem: client.fiscalDocumentItem,
      };
      return service.assertStillAvailable(tx, {
        id: 'draft-1',
        docType: FiscalDocType.FACTURA,
        items: [draftItem(qty)],
      });
    }

    it('un borrador por lo acreditado emite: la NC viva abrió el cupo', async () => {
      await expect(reassert([invoice(), creditNote('40', FORTY)], '40')).resolves.toBeUndefined();
    });

    it('un borrador por más de lo acreditado se rechaza al emitir', async () => {
      await expect(reassert([invoice(), creditNote('40', FORTY)], '41')).rejects.toThrow(
        'quedan 40.000',
      );
    });

    it('D-383: un borrador de un pedido anulado ya no se registra ni se emite', async () => {
      await expect(reassert([], '1', 'CANCELLED')).rejects.toThrow(
        'El pedido PED-000001 está anulado: este borrador ya no se registra ni se emite. Descártalo',
      );
    });

    it('con la NC anulada, el cupo sigue cerrado', async () => {
      await expect(
        reassert([invoice(), creditNote('40', FORTY, FiscalDocumentStatus.VOIDED)], '1'),
      ).rejects.toThrow('quedan 0.000');
    });
  });
});
