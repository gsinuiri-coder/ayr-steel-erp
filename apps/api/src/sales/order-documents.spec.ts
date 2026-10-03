import { Test } from '@nestjs/testing';
import { FiscalDocType, Prisma, Role, SalesOrderOrigin, SalesOrderStatus } from '@prisma/client';
import { LIVE_DOCUMENT_STATUSES } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import { ENV, type Env } from '../config/env';
import { InventoryService } from '../inventory/inventory.service';
import { RoofingProductionService } from '../production/roofing-production.service';
import { PrismaService } from '../prisma/prisma.service';
import { liveDocumentsByOrder, orderDocuments } from './order-documents';
import { SalesOrdersService } from './sales-orders.service';

/**
 * Correcciones 05 / M4: la lista de pedidos muestra a qué comprobante está asociado cada uno.
 *
 * El presupuesto: los comprobantes de toda la página salen de **una** consulta; el número de
 * consultas de `GET /sales/orders` no depende de cuántos pedidos se muestren.
 */

const ADMIN = {
  id: 'admin-1',
  email: 'admin@ayr.test',
  name: 'Administrador',
  role: Role.ADMINISTRADOR,
  mustChangePassword: false,
  sessionId: 'session-admin-1',
};

const dec = (v: string) => new Prisma.Decimal(v);
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function orderRow(i: number) {
  return {
    id: uuid(i),
    seq: i,
    quotationId: null,
    quotation: null,
    customerId: uuid(9000),
    customer: { id: uuid(9000), name: 'Cliente', docNumber: '20123456789' },
    status: SalesOrderStatus.CONFIRMED,
    origin: SalesOrderOrigin.CREATED_HERE,
    issueDate: new Date('2026-09-20T00:00:00.000Z'),
    subtotalPen: dec('100'),
    igvPen: dec('18'),
    totalPen: dec('118'),
    notes: null,
    createdAt: new Date('2026-09-20T10:00:00.000Z'),
    createdById: ADMIN.id,
    sellerId: ADMIN.id,
    cancelledAt: null,
    promisedDeliveryDate: null,
    _count: { items: 1, reservations: 0 },
  };
}

/** Dos comprobantes por pedido: una factura y su nota de crédito. */
function documentsOf(orders: { id: string }[]) {
  return orders.flatMap((o, i) => [
    {
      id: uuid(1000 + i * 2),
      number: `F001-${String(i * 2 + 1).padStart(8, '0')}`,
      docType: FiscalDocType.FACTURA,
      issueDate: new Date('2026-09-21T00:00:00.000Z'),
      salesOrderId: o.id,
    },
    {
      id: uuid(1000 + i * 2 + 1),
      number: `FC01-${String(i * 2 + 1).padStart(8, '0')}`,
      docType: FiscalDocType.NOTA_CREDITO,
      issueDate: new Date('2026-09-22T00:00:00.000Z'),
      salesOrderId: o.id,
    },
  ]);
}

describe('SalesOrdersService.findAll — comprobantes del pedido sin N+1 (Correcciones 05 / M4)', () => {
  let service: SalesOrdersService;
  let calls: number;
  let orders: ReturnType<typeof orderRow>[];
  let fiscalFindMany: jest.Mock;

  beforeEach(async () => {
    calls = 0;
    orders = [];
    const counted =
      <T>(value: () => T) =>
      () => {
        calls += 1;
        return Promise.resolve(value());
      };
    fiscalFindMany = jest.fn(counted(() => documentsOf(orders)));
    const prisma = {
      salesOrder: {
        count: jest.fn(counted(() => orders.length)),
        findMany: jest.fn(counted(() => orders)),
      },
      user: { findMany: jest.fn(counted(() => [{ id: ADMIN.id, name: ADMIN.name }])) },
      productionOrder: { findMany: jest.fn(counted(() => [])) },
      fiscalDocument: { findMany: fiscalFindMany },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        SalesOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { write: jest.fn(), log: jest.fn() } },
        { provide: InventoryService, useValue: {} },
        { provide: RoofingProductionService, useValue: {} },
        { provide: ENV, useValue: {} as Env },
      ],
    }).compile();
    service = moduleRef.get(SalesOrdersService);
  });

  async function countFor(n: number) {
    orders = Array.from({ length: n }, (_, i) => orderRow(i + 1));
    calls = 0;
    const page = await service.findAll(ADMIN, { page: 1, pageSize: 50 });
    return { calls, page };
  }

  it('las consultas no crecen con la cantidad de pedidos de la página', async () => {
    const one = await countFor(1);
    const twenty = await countFor(20);
    expect(twenty.calls).toBe(one.calls);
    // Medido: 5 (count, página, usuarios, comprobantes, órdenes de producción).
    expect(twenty.calls).toBe(5);
    expect(fiscalFindMany).toHaveBeenCalledTimes(2);
  });

  it('cada pedido recibe sus comprobantes, con la nota de crédito rotulada por su tipo', async () => {
    const { page } = await countFor(3);
    expect(page.items).toHaveLength(3);
    for (const [i, row] of page.items.entries()) {
      expect(row.documents?.map((d) => d.number)).toEqual([
        `F001-${String(i * 2 + 1).padStart(8, '0')}`,
        `FC01-${String(i * 2 + 1).padStart(8, '0')}`,
      ]);
      expect(row.documents?.[1]?.docType).toBe(FiscalDocType.NOTA_CREDITO);
      expect(row.documents?.[0]?.issueDate).toBe('2026-09-21');
    }
  });

  it('pide solo los vivos, sin archivados ni guías, ordenados por emisión y número', async () => {
    await countFor(2);
    const [args] = fiscalFindMany.mock.calls.at(-1) as [
      { where: Prisma.FiscalDocumentWhereInput; orderBy: unknown },
    ];
    expect(args.where.archivedAt).toBeNull();
    expect(args.where.status).toEqual({ in: [...LIVE_DOCUMENT_STATUSES] });
    expect(args.where.docType).toEqual({
      in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA, FiscalDocType.NOTA_CREDITO],
    });
    expect(args.orderBy).toEqual([{ issueDate: 'asc' }, { number: 'asc' }]);
  });
});

describe('orderDocuments (UAT de cc13)', () => {
  const row = (id: string, status: string) => ({
    id,
    number: `F001-${id}`,
    docType: FiscalDocType.FACTURA,
    issueDate: new Date('2026-09-22T00:00:00.000Z'),
    status,
  });

  it('una sola consulta: separa los vivos y cuenta los anulados', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([row('1', 'ACCEPTED'), row('2', 'ANNULLED'), row('3', 'ANNULLED')]);
    const out = await orderDocuments({ fiscalDocument: { findMany } } as never, 'so-1');
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = (findMany.mock.calls as unknown[][])[0]![0] as {
      where: { status: { in: string[] } };
    };
    expect(args.where.status.in).toEqual([...LIVE_DOCUMENT_STATUSES, 'ANNULLED']);
    expect(out.live.map((d) => d.id)).toEqual(['1']);
    expect(out.annulledCount).toBe(2);
  });

  it('sin anulados, la cuenta es 0', async () => {
    const findMany = jest.fn().mockResolvedValue([row('1', 'ACCEPTED')]);
    const out = await orderDocuments({ fiscalDocument: { findMany } } as never, 'so-1');
    expect(out.annulledCount).toBe(0);
  });
});

describe('liveDocumentsByOrder', () => {
  it('sin pedidos no consulta', async () => {
    const findMany = jest.fn();
    const out = await liveDocumentsByOrder({ fiscalDocument: { findMany } } as never, []);
    expect(out.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
