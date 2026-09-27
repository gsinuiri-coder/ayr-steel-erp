import { AuditActorKind, QuotationStatus, type Prisma } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import { productsWithUsage } from '../catalog/product-usage';
import {
  executeQuotationPurge,
  formatPurgeReport,
  parseQuotationNumber,
  planQuotationPurge,
} from './quotation-purge';

jest.mock('../catalog/product-usage', () => ({ productsWithUsage: jest.fn() }));
const usageMock = jest.mocked(productsWithUsage);

/**
 * D-350 — purga de cotizaciones anuladas elegidas por el dueño: solo ANULADA, sin pedido, sin
 * reservas temporales que no estén RELEASED; se van sus líneas, sus reservas RELEASED y su
 * historial de precio; el PDF queda huérfano en R2 y se reporta.
 */

interface Row {
  seq: number;
  status?: QuotationStatus;
  orders?: number[];
  reservations?: string[];
  priceChanges?: number;
  pdfKey?: string | null;
  products?: string[];
}

function quotation(r: Row) {
  return {
    id: `q-${String(r.seq)}`,
    seq: r.seq,
    status: r.status ?? QuotationStatus.CANCELLED,
    pdfKey: r.pdfKey ?? null,
    customerId: 'c-1',
    customer: { name: 'Cliente SAC' },
    items: (r.products ?? ['p-1']).map((productId) => ({ productId })),
    salesOrders: (r.orders ?? []).map((seq) => ({ seq })),
    temporaryReservations: (r.reservations ?? []).map((status) => ({ status })),
    _count: { priceChanges: r.priceChanges ?? 0 },
  };
}

function fakeTx(rows: Row[]) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    quotation: {
      findMany: jest.fn(({ where }: { where: { seq: { in: number[] } } }) =>
        Promise.resolve(rows.filter((r) => where.seq.in.includes(r.seq)).map(quotation)),
      ),
      delete: jest.fn().mockResolvedValue({}),
    },
    product: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.map((id) => ({
            id,
            sku: id.toUpperCase(),
            name: `Producto ${id}`,
            businessLine: { code: 'TRADING' },
          })),
        ),
      ),
    },
    salesPriceChange: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    quotationReservation: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  return tx;
}

const asTx = (t: ReturnType<typeof fakeTx>) => t as unknown as Prisma.TransactionClient;

describe('parseQuotationNumber', () => {
  it.each([
    ['COT-000123', 123],
    ['cot-12', 12],
    ['COT12', 12],
    [' 45 ', 45],
    ['PED-000001', null],
    ['COT-0', null],
    ['', null],
  ])('%s → %s', (raw, seq) => {
    expect(parseQuotationNumber(raw)).toBe(seq);
  });
});

describe('planQuotationPurge (D-350) — cada bloqueo', () => {
  beforeEach(() => {
    usageMock.mockReset().mockResolvedValue(new Set());
  });

  it('una anulada sin pedido ni reservas vivas se puede borrar', async () => {
    const plan = await planQuotationPurge(asTx(fakeTx([{ seq: 7, priceChanges: 2 }])), [
      'COT-000007',
    ]);
    expect(plan.blocked).toEqual([]);
    expect(plan.purgeable).toMatchObject([
      { code: 'COT-000007', customerName: 'Cliente SAC', priceChanges: 2 },
    ]);
  });

  it.each([QuotationStatus.EMITTED, QuotationStatus.EXPIRED, QuotationStatus.CONFIRMED])(
    'una cotización %s no se toca',
    async (status) => {
      const plan = await planQuotationPurge(asTx(fakeTx([{ seq: 7, status }])), ['COT-000007']);
      expect(plan.purgeable).toEqual([]);
      expect(plan.blocked[0]?.reasons).toEqual([`está ${status}, no ANULADA`]);
    },
  );

  it('con un pedido (aunque esté anulado) no se toca', async () => {
    const plan = await planQuotationPurge(asTx(fakeTx([{ seq: 7, orders: [3] }])), ['7']);
    expect(plan.blocked[0]?.reasons).toEqual(['tiene pedido(s) PED-000003']);
  });

  it.each(['ACTIVE', 'CONVERTED', 'EXPIRED'])(
    'una reserva temporal %s la bloquea; las RELEASED no',
    async (status) => {
      const plan = await planQuotationPurge(
        asTx(fakeTx([{ seq: 7, reservations: ['RELEASED', status] }])),
        ['COT-000007'],
      );
      expect(plan.blocked[0]?.reasons[0]).toMatch(
        new RegExp(`1 reserva\\(s\\) temporal\\(es\\) no liberada\\(s\\) \\(${status}\\)`),
      );
    },
  );

  it('un número que no existe o que no es de cotización se reporta, no rompe', async () => {
    const plan = await planQuotationPurge(asTx(fakeTx([])), ['COT-000099', 'PED-1']);
    expect(plan.blocked).toEqual(
      expect.arrayContaining([
        { code: 'PED-1', status: null, reasons: ['no es un número de cotización'] },
        { code: 'COT-000099', status: null, reasons: ['no existe'] },
      ]),
    );
  });

  it('lista los productos que quedarían sin uso, excluyendo las cotizaciones a borrar', async () => {
    usageMock.mockResolvedValue(new Set(['p-2']));
    const plan = await planQuotationPurge(asTx(fakeTx([{ seq: 7, products: ['p-1', 'p-2'] }])), [
      'COT-000007',
    ]);
    expect(plan.freedProducts.map((p) => p.id)).toEqual(['p-1']);
    expect(usageMock).toHaveBeenCalledWith(expect.anything(), expect.any(Array), {
      excludeQuotationIds: ['q-7'],
    });
  });
});

describe('executeQuotationPurge (D-350)', () => {
  const audit = { write: jest.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    usageMock.mockReset().mockResolvedValue(new Set());
    audit.write.mockClear();
  });

  it('borra historial, reservas RELEASED y la cotización; audita número y cliente; lista el PDF', async () => {
    const tx = fakeTx([{ seq: 7, reservations: ['RELEASED'], pdfKey: 'quotations/q-7.pdf' }]);
    const result = await executeQuotationPurge(
      asTx(tx),
      audit as unknown as AuditService,
      ['COT-000007'],
      ['COT-000007'],
    );
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.salesPriceChange.deleteMany).toHaveBeenCalledWith({ where: { quotationId: 'q-7' } });
    expect(tx.quotationReservation.deleteMany).toHaveBeenCalledWith({
      where: { quotationId: 'q-7', status: 'RELEASED' },
    });
    expect(tx.quotation.delete).toHaveBeenCalledWith({ where: { id: 'q-7' } });
    expect(audit.write).toHaveBeenCalledWith(tx, {
      actorId: null,
      actorKind: AuditActorKind.SYSTEM,
      action: 'quotations.purge',
      entity: 'quotations',
      entityId: 'q-7',
      before: { code: 'COT-000007', customerId: 'c-1', customerName: 'Cliente SAC' },
    });
    expect(result.orphanPdfKeys).toEqual(['quotations/q-7.pdf']);
  });

  it('las bloqueadas no se tocan y las demás se borran', async () => {
    const tx = fakeTx([{ seq: 7 }, { seq: 8, orders: [1] }]);
    const result = await executeQuotationPurge(
      asTx(tx),
      audit as unknown as AuditService,
      ['COT-000007', 'COT-000008'],
      ['COT-000007'],
    );
    expect(tx.quotation.delete).toHaveBeenCalledTimes(1);
    expect(result.blocked.map((b) => b.code)).toEqual(['COT-000008']);
  });

  it('si el plan cambió desde el dry-run no borra nada', async () => {
    const tx = fakeTx([{ seq: 7, orders: [1] }]);
    await expect(
      executeQuotationPurge(
        asTx(tx),
        audit as unknown as AuditService,
        ['COT-000007'],
        ['COT-000007'],
      ),
    ).rejects.toThrow(/El plan cambió desde el dry-run/);
    expect(tx.quotation.delete).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });
});

describe('formatPurgeReport', () => {
  it('muestra lo que se borra, lo bloqueado, los productos liberados y los PDF huérfanos', () => {
    const report = formatPurgeReport(
      {
        purgeable: [
          {
            code: 'COT-000007',
            id: 'q-7',
            customerId: 'c-1',
            customerName: 'Cliente SAC',
            status: QuotationStatus.CANCELLED,
            itemCount: 2,
            releasedReservations: 1,
            priceChanges: 0,
            pdfKey: 'k.pdf',
            productIds: ['p-1'],
          },
        ],
        blocked: [{ code: 'COT-000008', status: QuotationStatus.EMITTED, reasons: ['x'] }],
        freedProducts: [{ id: 'p-1', sku: 'ACCES030ROJO', name: 'Accesorio' }],
      },
      'Encabezado',
    );
    expect(report).toContain('COT-000007  CANCELLED  Cliente SAC');
    expect(report).toContain('COT-000008  EMITTED  x');
    expect(report).toContain('ACCES030ROJO  Accesorio');
    expect(report).toContain('PDF en R2 que quedan huérfanos (no se borran): 1\n  k.pdf');
  });
});
