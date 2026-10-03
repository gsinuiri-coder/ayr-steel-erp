import { ForbiddenException } from '@nestjs/common';
import {
  FiscalDocType,
  FiscalDocumentOrigin,
  FiscalDocumentStatus,
  Prisma,
  Role,
} from '@prisma/client';
import type { RequestUser } from '../auth/auth.types';
import { FiscalImportService } from './fiscal-import.service';

/**
 * UAT de cc13: la sección «Comprobantes anulados» del pedido. Lee sin bloqueos ni transacción,
 * dice si aplican las dos reactivaciones y, si no, por qué, y tiene un presupuesto de consultas
 * verificado acá (AGENTS.md §6: consulta agregada con presupuesto, no caché silenciosa).
 */
describe('FiscalImportService.annulledOfOrder (cc13)', () => {
  const ADMIN: RequestUser = {
    id: 'admin-1',
    email: 'admin@ayr.test',
    name: 'Admin',
    role: Role.ADMINISTRADOR,
    mustChangePassword: false,
    sessionId: 'session-1',
  };
  const SELLER: RequestUser = { ...ADMIN, id: 'seller-1', role: Role.VENDEDOR };
  const ANNULLED_AT = new Date('2026-10-01T06:19:10.000Z');
  const dec = (v: string) => new Prisma.Decimal(v);

  const listed = {
    id: 'doc-1382',
    number: 'FFA1-00001382',
    docType: FiscalDocType.FACTURA,
    origin: FiscalDocumentOrigin.MANUAL,
    status: FiscalDocumentStatus.ANNULLED,
    issueDate: new Date('2026-09-22T00:00:00.000Z'),
    totalPen: dec('118'),
    salesOrderId: 'so-11',
    archivedAt: null,
    annulledAt: ANNULLED_AT,
    annulledById: 'admin-0',
    annulReason: 'faltó un ítem',
  };

  const full = {
    ...listed,
    annulledById: 'admin-0',
    sendAttempts: 0,
    lastAttemptAt: null,
    providerTicket: null,
    providerResponse: null,
    sunatHash: null,
    xmlKey: null,
    cdrKey: null,
    voidRequestedAt: null,
    voidedAt: null,
    salesOrder: { seq: 11 },
    customerId: 'cust-1',
    detractionCode: null,
    subtotalPen: dec('100'),
    igvPen: dec('18'),
    items: [
      {
        id: 'fdi-1',
        lineNumber: 1,
        productId: 'p-1',
        description: 'Cobertura roja (papel)',
        qty: dec('48'),
        unit: 'MTR',
        unitPricePen: dec('2.0833'),
        subtotalPen: dec('100'),
        igvPen: dec('18'),
        totalPen: dec('118'),
        salesOrderItemId: 'soi-1',
      },
    ],
  };

  const line1 = {
    id: 'soi-1',
    lineNumber: 1,
    productId: 'p-1',
    description: 'Cobertura roja',
    qty: dec('48'),
    unit: 'MTR',
    subtotalPen: dec('100'),
    igvPen: dec('18'),
    totalPen: dec('118'),
  };
  const line2 = {
    id: 'soi-2',
    lineNumber: 2,
    productId: 'p-2',
    description: 'Tornillo',
    qty: dec('3'),
    unit: 'NIU',
    subtotalPen: dec('30.03'),
    igvPen: dec('5.4054'),
    totalPen: dec('35.4354'),
  };

  function build(opts: { docs?: object[]; orderLines?: object[]; payments?: number } = {}) {
    const docs = opts.docs ?? [listed];
    const prisma = {
      $transaction: jest.fn(),
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ status: 'CONFIRMED', customer_id: 'cust-1', seq: 11 }]),
      fiscalDocument: {
        // 1.ª: los anulados del pedido; después, por anulado: notas de crédito (común) y otros
        // comprobantes vivos (D-378).
        findMany: jest.fn().mockResolvedValueOnce(docs).mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(full),
        count: jest.fn().mockResolvedValue(0),
      },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'admin-0', name: 'Dueño' }]) },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue({
          before: { status: FiscalDocumentStatus.ACCEPTED, totalPen: '118.0000' },
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      customerPayment: { count: jest.fn().mockResolvedValue(opts.payments ?? 0) },
      salesOrderItem: { findMany: jest.fn().mockResolvedValue(opts.orderLines ?? [line1, line2]) },
      fiscalDocumentItem: { groupBy: jest.fn().mockResolvedValue([]) },
      customer: { findUnique: jest.fn().mockResolvedValue({ isSystem: false }) },
    };
    const audit = { write: jest.fn() };
    const service = new FiscalImportService(prisma as never, audit as never);
    return { service, prisma, audit };
  }

  /** Cada llamada a un método de un modelo, o a `$queryRaw`, es una consulta. */
  function queries(prisma: ReturnType<typeof build>['prisma']): number {
    let n = prisma.$queryRaw.mock.calls.length;
    for (const model of Object.values(prisma)) {
      if (typeof model !== 'object') continue;
      for (const fn of Object.values(model as Record<string, jest.Mock>)) {
        n += fn.mock.calls.length;
      }
    }
    return n;
  }

  /** El texto SQL de una llamada a `$queryRaw` (las plantillas, sin los valores). */
  function sqlOf(call: unknown[]): string {
    return (call as [TemplateStringsArray])[0].join('?');
  }

  it('lista el anulado con las dos reactivaciones disponibles, sin transacción ni FOR UPDATE', async () => {
    const { service, prisma, audit } = build();
    const rows = await service.annulledOfOrder(ADMIN, 'so-11');

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'doc-1382',
        number: 'FFA1-00001382',
        issueDate: '2026-09-22',
        totalPen: '118.0000',
        annulledAt: ANNULLED_AT.toISOString(),
        annulledByName: 'Dueño',
        annulReason: 'faltó un ítem',
        withOrderLines: { ok: true, reason: null },
        simple: { ok: true, reason: null },
      }),
    ]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    for (const call of prisma.$queryRaw.mock.calls) {
      expect(sqlOf(call)).not.toMatch(/FOR UPDATE/);
    }
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('presupuesto: 2 fijas + 16 por anulado (4 comunes, 5 de D-378, 7 de D-373)', async () => {
    const { service, prisma } = build();
    await service.annulledOfOrder(ADMIN, 'so-11');
    expect(queries(prisma)).toBe(18);

    const two = build({ docs: [listed, { ...listed, id: 'doc-2', number: 'FFA1-00001400' }] });
    await two.service.annulledOfOrder(ADMIN, 'so-11');
    expect(queries(two.prisma)).toBe(2 + 16 * 2);
  });

  it('un pedido sin anulados paga una sola consulta', async () => {
    const { service, prisma } = build({ docs: [] });
    await expect(service.annulledOfOrder(ADMIN, 'so-11')).resolves.toEqual([]);
    expect(queries(prisma)).toBe(1);
  });

  it('si el pedido no cambió, «con las líneas» queda bloqueada con el motivo y «Reactivar» no', async () => {
    const { service } = build({ orderLines: [line1] });
    const [row] = await service.annulledOfOrder(ADMIN, 'so-11');
    expect(row?.withOrderLines).toEqual({
      ok: false,
      reason:
        'Las líneas del pedido PED-000011 son las mismas de FFA1-00001382: no hay nada que cambiar. Usa «Reactivar»',
    });
    expect(row?.simple).toEqual({ ok: true, reason: null });
  });

  it('un bloqueo común (cobros) bloquea las dos con el mismo motivo, y no sigue consultando', async () => {
    const { service, prisma } = build({ payments: 1 });
    const [row] = await service.annulledOfOrder(ADMIN, 'so-11');
    expect(row?.withOrderLines.ok).toBe(false);
    expect(row?.withOrderLines.reason).toMatch(/tiene cobros vigentes/);
    expect(row?.simple).toEqual(row?.withOrderLines);
    expect(prisma.salesOrderItem.findMany).not.toHaveBeenCalled();
  });

  it('solo un administrador', async () => {
    const { service, prisma } = build();
    await expect(service.annulledOfOrder(SELLER, 'so-11')).rejects.toThrow(ForbiddenException);
    expect(queries(prisma)).toBe(0);
  });
});
