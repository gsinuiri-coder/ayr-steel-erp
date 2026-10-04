import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, ReservationStatus, Role, SalesOrderStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ENV, type Env } from '../config/env';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { RoofingProductionService } from '../production/roofing-production.service';
import { fabricatedLooseLines } from './order-cancel-checks';
import { SalesOrdersService } from './sales-orders.service';

/**
 * D-383: anular un pedido. Se bloquea con un comprobante vivo o un despacho vigente; con
 * producto fabricado sin despachar exige la casilla y la audita. Cada caso parte de un pedido
 * que se anula sin problemas (`happy`), para que un test en verde diga que **ese** bloqueo es el
 * que frena.
 */
describe('D-383 — anular un pedido', () => {
  const ADMIN = {
    id: 'admin-1',
    email: 'admin@ayr.test',
    name: 'Administrador',
    role: Role.ADMINISTRADOR,
    mustChangePassword: false,
    sessionId: 's-admin',
  };
  const D = (v: string) => new Prisma.Decimal(v);

  interface Scenario {
    docs: {
      number: string | null;
      origin: string;
      docType?: string;
      status?: string;
      createdAt?: Date;
      totalPen: Prisma.Decimal;
      creditNotes: { totalPen: Prisma.Decimal }[];
    }[];
    dispatches: { seq: number }[];
    reports: {
      id: string;
      productionOrder: {
        seq: number;
        status: string;
        reservation: { salesOrderItemId: string } | null;
      };
    }[];
    movements: { refId: string | null; itemId: string; qty: Prisma.Decimal }[];
    shipped: {
      salesOrderItemId: string;
      itemId: string;
      _sum: { reserveQty: Prisma.Decimal | null };
    }[];
  }

  function happy(): Scenario {
    return { docs: [], dispatches: [], reports: [], movements: [], shipped: [] };
  }

  /** Lo que la consulta trae: vivos y borradores. Por defecto, una factura aceptada. */
  const withDocDefaults = (docs: Scenario['docs']) =>
    docs.map((d) => ({
      docType: 'FACTURA',
      status: 'ACCEPTED',
      createdAt: new Date('2026-10-03T15:00:00.000Z'),
      ...d,
    }));

  /** Lo fabricado de la línea 1 (24.6 m de COB-ROJO en OP-000012, cerrada). */
  function withFabricated(s: Scenario): Scenario {
    s.reports = [
      {
        id: 'rep-1',
        productionOrder: {
          seq: 12,
          status: 'CLOSED',
          reservation: { salesOrderItemId: 'soi-1' },
        },
      },
    ];
    s.movements = [{ refId: 'rep-1', itemId: 'p-1', qty: D('24.600') }];
    return s;
  }

  async function build(s: Scenario) {
    const audit = { write: jest.fn().mockResolvedValue(undefined) };
    const queryRaw = jest.fn((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join('?').includes('FROM "sales_orders"')
          ? [
              {
                id: 'o-1',
                seq: 7,
                status: SalesOrderStatus.CONFIRMED,
                origin: 'CREATED_HERE',
                quotation_id: null,
                promised_delivery_date: null,
              },
            ]
          : [],
      ),
    );
    const salesOrderItems = [
      {
        id: 'soi-1',
        lineNumber: 1,
        productId: 'p-1',
        description: 'Cobertura roja a medida',
        product: { sku: 'COB-ROJO', unit: 'MTR' },
      },
    ];
    const tx = {
      $queryRaw: queryRaw,
      reservation: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'res-p',
            status: ReservationStatus.ACTIVE,
            shortfallQty: D('0'),
            productionOrders: [],
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      salesOrder: { update: jest.fn() },
      salesOrderItem: {
        findMany: jest.fn((args: { select: Record<string, unknown> }) =>
          Promise.resolve(
            'lineNumber' in args.select
              ? salesOrderItems
              : salesOrderItems.map((i) => ({ id: i.id })),
          ),
        ),
      },
      fiscalDocument: { findMany: jest.fn().mockResolvedValue(withDocDefaults(s.docs)) },
      dispatch: { findMany: jest.fn().mockResolvedValue(s.dispatches) },
      productionReport: { findMany: jest.fn().mockResolvedValue(s.reports) },
      inventoryMovement: { findMany: jest.fn().mockResolvedValue(s.movements) },
      dispatchItem: { groupBy: jest.fn().mockResolvedValue(s.shipped) },
    };
    const prisma = {
      $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        SalesOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: InventoryService, useValue: { lockAvailability: jest.fn() } },
        { provide: RoofingProductionService, useValue: {} },
        { provide: ENV, useValue: {} as Env },
      ],
    }).compile();
    const service = moduleRef.get(SalesOrdersService);
    jest.spyOn(service, 'findOne').mockResolvedValue({} as never);
    return { service, tx, audit };
  }

  async function rejects(s: Scenario, type: unknown, message: string | RegExp, ack = false) {
    const { service, tx, audit } = await build(s);
    const err = await service
      .cancel(ADMIN, 'o-1', { reason: 'el cliente desistió', acknowledgeFabricated: ack })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(type as never);
    expect((err as Error).message).toMatch(message);
    expect(tx.salesOrder.update).not.toHaveBeenCalled();
    expect(tx.reservation.updateMany).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  }

  it('sin comprobantes, despachos ni fabricado, anula como siempre', async () => {
    const { service, tx, audit } = await build(happy());
    await service.cancel(ADMIN, 'o-1', { reason: 'el cliente desistió' });
    expect(tx.salesOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    );
    const event = (audit.write.mock.calls as unknown[][])[0]![1] as {
      after: Record<string, unknown>;
    };
    expect(event.after).not.toHaveProperty('fabricatedLoose');
  });

  it('toma el lock de los borradores del pedido antes de mirar los comprobantes', async () => {
    const { service, tx } = await build(happy());
    await service.cancel(ADMIN, 'o-1', { reason: 'el cliente desistió' });
    const sqls = (tx.$queryRaw.mock.calls as unknown[][]).map((c) =>
      (c[0] as TemplateStringsArray).join('?'),
    );
    expect(sqls.some((q) => q.includes('"fiscal_documents"') && q.includes('FOR UPDATE'))).toBe(
      true,
    );
  });

  describe('(1) bloqueos', () => {
    it('un comprobante manual vivo: primero se anula', async () => {
      const s = happy();
      s.docs = [
        { number: 'FFA1-00001389', origin: 'MANUAL', totalPen: D('2448'), creditNotes: [] },
      ];
      await rejects(
        s,
        BadRequestException,
        'El pedido PED-000007 tiene el comprobante FFA1-00001389 vigente: anúlalo internamente antes de anular el pedido',
      );
    });

    it('uno emitido por el ERP: el mensaje dice baja o nota de crédito', async () => {
      const s = happy();
      s.docs = [
        { number: 'B001-00000010', origin: 'ISSUED_HERE', totalPen: D('118'), creditNotes: [] },
      ];
      await rejects(s, BadRequestException, /con baja o nota de crédito/);
    });

    it('acreditado solo en parte sigue vivo', async () => {
      const s = happy();
      s.docs = [
        {
          number: 'B001-00000010',
          origin: 'ISSUED_HERE',
          totalPen: D('118'),
          creditNotes: [{ totalPen: D('50') }],
        },
      ];
      await rejects(s, BadRequestException, /B001-00000010 vigente/);
    });

    it('acreditado por completo con notas vivas no bloquea (la anulación del mostrador)', async () => {
      const s = happy();
      s.docs = [
        {
          number: 'B001-00000010',
          origin: 'ISSUED_HERE',
          totalPen: D('118'),
          creditNotes: [{ totalPen: D('118') }],
        },
      ];
      const { service, tx } = await build(s);
      await service.cancel(ADMIN, 'o-1', { reason: 'anulación de venta de mostrador' });
      expect(tx.salesOrder.update).toHaveBeenCalled();
    });

    it('despachos vigentes: primero se revierten', async () => {
      const s = happy();
      s.dispatches = [{ seq: 40 }, { seq: 41 }];
      await rejects(
        s,
        BadRequestException,
        'El pedido PED-000007 tiene los despachos DES-000040, DES-000041 vigentes: reviértelos antes de anular el pedido',
      );
    });

    it('comprobante y despacho a la vez: los dos motivos', async () => {
      const s = happy();
      s.docs = [{ number: 'FFA1-1', origin: 'MANUAL', totalPen: D('10'), creditNotes: [] }];
      s.dispatches = [{ seq: 3 }];
      await rejects(
        s,
        BadRequestException,
        /FFA1-1 vigente.*\. El pedido PED-000007 tiene el despacho DES-000003 vigente/,
      );
    });

    it('decisión del dueño: un borrador bloquea, nombrado, y no se borra solo', async () => {
      const s = happy();
      s.docs = [
        {
          number: null,
          origin: 'ISSUED_HERE',
          docType: 'FACTURA',
          status: 'DRAFT',
          // 01:40 UTC del 2 de octubre es 1 de octubre en Lima.
          createdAt: new Date('2026-10-02T01:40:45.000Z'),
          totalPen: D('6438'),
          creditNotes: [],
        },
      ];
      await rejects(
        s,
        BadRequestException,
        'El pedido PED-000007 tiene un borrador de comprobante: elimina primero el borrador (factura del 01/10/2026 por S/ 6438.00) antes de anular el pedido',
      );
    });

    it('dos borradores: los nombra a los dos', async () => {
      const s = happy();
      s.docs = [
        {
          number: null,
          origin: 'ISSUED_HERE',
          status: 'DRAFT',
          totalPen: D('10'),
          creditNotes: [],
        },
        {
          number: null,
          origin: 'ISSUED_HERE',
          docType: 'BOLETA',
          status: 'DRAFT',
          totalPen: D('5'),
          creditNotes: [],
        },
      ];
      await rejects(
        s,
        BadRequestException,
        /tiene 2 borradores de comprobante: elimina primero los borradores \(factura del 03\/10\/2026 por S\/ 10\.00; boleta del 03\/10\/2026 por S\/ 5\.00\)/,
      );
    });

    it('acreditado por completo al céntimo, con un resto en el cuarto decimal, no bloquea', async () => {
      const s = happy();
      s.docs = [
        {
          number: 'B001-00000011',
          origin: 'ISSUED_HERE',
          totalPen: D('118.0049'),
          creditNotes: [{ totalPen: D('118.0000') }],
        },
      ];
      const { service, tx } = await build(s);
      await service.cancel(ADMIN, 'o-1', { reason: 'anulación de venta de mostrador' });
      expect(tx.salesOrder.update).toHaveBeenCalled();
    });
  });

  describe('(2) producto fabricado sin despachar', () => {
    it('sin la casilla, rechaza con la línea, la cantidad y la OP', async () => {
      await rejects(
        withFabricated(happy()),
        ConflictException,
        'El pedido PED-000007 tiene producto fabricado sin despachar (línea 1 COB-ROJO: 24.6 MTR (OP-000012)). Al anularlo queda en inventario sin pedido y nadie lo toma hasta revertir la producción: confirma que lo entiendes para anular',
      );
    });

    it('con la casilla, anula y audita lo que quedó suelto', async () => {
      const { service, tx, audit } = await build(withFabricated(happy()));
      await service.cancel(ADMIN, 'o-1', {
        reason: 'el cliente desistió',
        acknowledgeFabricated: true,
      });
      expect(tx.salesOrder.update).toHaveBeenCalled();
      const event = (audit.write.mock.calls as unknown[][])[0]![1] as {
        action: string;
        after: Record<string, unknown>;
      };
      expect(event.action).toBe('sales.order.cancel');
      expect(event.after).toMatchObject({
        acknowledgedFabricated: true,
        fabricatedLoose: [
          {
            lineNumber: 1,
            sku: 'COB-ROJO',
            qty: '24.600',
            unit: 'MTR',
            productionOrders: ['OP-000012'],
          },
        ],
      });
    });

    it('lo ya despachado no cuenta: con todo despachado no pide casilla', async () => {
      const s = withFabricated(happy());
      s.shipped = [{ salesOrderItemId: 'soi-1', itemId: 'p-1', _sum: { reserveQty: D('24.600') } }];
      const { service, tx } = await build(s);
      await service.cancel(ADMIN, 'o-1', { reason: 'el cliente desistió' });
      expect(tx.salesOrder.update).toHaveBeenCalled();
    });

    it('un bloqueo comercial gana sobre la casilla: no se anula aunque venga confirmada', async () => {
      const s = withFabricated(happy());
      s.dispatches = [{ seq: 5 }];
      await rejects(s, BadRequestException, /DES-000005 vigente/, true);
    });
  });

  describe('vista previa (sin bloqueos)', () => {
    async function preview(s: Scenario, annulled: { id: string; number: string }[] = []) {
      const { tx } = await build(s);
      const findManyDocs = jest
        .fn()
        // Comprobantes vivos y, después, los manuales anulados.
        .mockResolvedValueOnce(withDocDefaults(s.docs))
        .mockResolvedValueOnce(annulled);
      const reader = {
        ...tx,
        fiscalDocument: { findMany: findManyDocs },
        salesOrder: {
          findUnique: jest.fn().mockResolvedValue({ seq: 7, status: SalesOrderStatus.CONFIRMED }),
        },
        productionOrder: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          SalesOrdersService,
          { provide: PrismaService, useValue: reader },
          { provide: AuditService, useValue: { write: jest.fn() } },
          { provide: InventoryService, useValue: {} },
          { provide: RoofingProductionService, useValue: {} },
          { provide: ENV, useValue: {} as Env },
        ],
      }).compile();
      const service = moduleRef.get(SalesOrdersService);
      const calls = () =>
        Object.values(reader).reduce<number>((n, model) => {
          if (typeof model === 'function') return n + (model as jest.Mock).mock.calls.length;
          return (
            n +
            Object.values(model as Record<string, jest.Mock>).reduce(
              (m, f) => m + f.mock.calls.length,
              0,
            )
          );
        }, 0);
      return { service, reader, calls };
    }

    it('junta bloqueos, fabricado y anulados manuales, sin FOR UPDATE ni escrituras', async () => {
      const s = withFabricated(happy());
      s.dispatches = [{ seq: 9 }];
      const { service, reader } = await preview(s, [{ id: 'd-1', number: 'FFA1-00000001' }]);
      const out = await service.cancelPreview('o-1');
      expect(out.blocks).toEqual([
        'El pedido PED-000007 tiene el despacho DES-000009 vigente: reviértelo antes de anular el pedido',
      ]);
      expect(out.fabricated.map((l) => [l.lineNumber, l.qty])).toEqual([[1, '24.600']]);
      expect(out.annulledManualDocuments).toEqual([{ id: 'd-1', number: 'FFA1-00000001' }]);
      expect(reader.$queryRaw).not.toHaveBeenCalled();
      expect(reader.reservation.updateMany).not.toHaveBeenCalled();
    });

    it('presupuesto (AGENTS.md §3.4): 7 consultas sin fabricado, 10 con fabricado', async () => {
      const plain = await preview(happy());
      await plain.service.cancelPreview('o-1');
      // pedido, OP en curso, líneas, comprobantes, despachos, reportes vivos, anulados manuales.
      expect(plain.calls()).toBe(7);
      const made = await preview(withFabricated(happy()));
      await made.service.cancelPreview('o-1');
      // + líneas de lo fabricado, movimientos y despachado por línea.
      expect(made.calls()).toBe(10);
    });
  });

  describe('fabricatedLooseLines (pura sobre el cliente)', () => {
    const db = (s: Scenario, items: unknown[]) =>
      ({
        productionReport: { findMany: jest.fn().mockResolvedValue(s.reports) },
        salesOrderItem: { findMany: jest.fn().mockResolvedValue(items) },
        inventoryMovement: { findMany: jest.fn().mockResolvedValue(s.movements) },
        dispatchItem: { groupBy: jest.fn().mockResolvedValue(s.shipped) },
      }) as never;
    const item = {
      id: 'soi-1',
      lineNumber: 1,
      productId: 'p-1',
      description: 'Cobertura',
      product: { sku: 'COB-ROJO', unit: 'MTR' },
    };

    it('sin reportes vivos no hace más consultas', async () => {
      const client = db(happy(), []) as unknown as {
        salesOrderItem: { findMany: jest.Mock };
      };
      await expect(fabricatedLooseLines(client as never, 'o-1')).resolves.toEqual([]);
      expect(client.salesOrderItem.findMany).not.toHaveBeenCalled();
    });

    it('resta lo despachado y solo cuenta el producto que la línea vende hoy', async () => {
      const s = withFabricated(happy());
      s.movements.push({ refId: 'rep-1', itemId: 'p-otra-bobina', qty: D('10') });
      s.shipped = [{ salesOrderItemId: 'soi-1', itemId: 'p-1', _sum: { reserveQty: D('4.6') } }];
      const out = await fabricatedLooseLines(db(s, [item]), 'o-1');
      expect(out).toEqual([
        {
          salesOrderItemId: 'soi-1',
          lineNumber: 1,
          sku: 'COB-ROJO',
          description: 'Cobertura',
          qty: '20.000',
          unit: 'MTR',
          productionOrders: [{ code: 'OP-000012', status: 'CLOSED' }],
        },
      ]);
    });
  });
});
