import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
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
 * D-373: reactivar un comprobante manual o importado anulado por error. Cada bloqueo se prueba
 * por separado, partiendo de un caso que pasa todos (`happy`), para que un test en verde diga
 * que **ese** bloqueo es el que frena y no otro anterior.
 */
describe('FiscalImportService.reactivateExternal (D-373)', () => {
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
  const INPUT = { reason: 'Anulado por error', confirmStillValid: true };

  interface Scenario {
    document: Record<string, unknown> | null;
    annulBefore: Prisma.JsonValue | undefined;
    payments: number;
    creditNotes: { number: string | null }[];
    orderItems: { id: string; lineNumber: number; qty: Prisma.Decimal }[];
    /** Lo que **otros** comprobantes vivos facturaron, por línea de pedido. */
    emitted: { salesOrderItemId: string; qty: string }[];
    others: { number: string | null }[];
    drafts: number;
    /** Estado del pedido, leído con su lock. */
    orderStatus: string;
    /** Eventos de edición de líneas del pedido posteriores a la anulación. */
    orderEdits: { before: Prisma.JsonValue }[];
    updated: number;
  }

  function happy(): Scenario {
    return {
      document: {
        id: 'doc-341',
        docType: FiscalDocType.BOLETA,
        number: 'BBV1-00000341',
        origin: FiscalDocumentOrigin.MANUAL,
        status: FiscalDocumentStatus.ANNULLED,
        archivedAt: null,
        annulledAt: ANNULLED_AT,
        annulledById: 'admin-0',
        annulReason: 'mal despacho',
        sendAttempts: 0,
        lastAttemptAt: null,
        providerTicket: null,
        providerResponse: null,
        sunatHash: null,
        xmlKey: null,
        cdrKey: null,
        voidRequestedAt: null,
        voidedAt: null,
        salesOrderId: 'so-48',
        salesOrder: { seq: 48 },
        items: [
          { qty: new Prisma.Decimal('12'), salesOrderItemId: 'soi-1' },
          { qty: new Prisma.Decimal('100'), salesOrderItemId: 'soi-2' },
        ],
      },
      annulBefore: { status: FiscalDocumentStatus.ACCEPTED, totalPen: '100.0000' },
      payments: 0,
      creditNotes: [],
      orderItems: [
        { id: 'soi-1', lineNumber: 1, qty: new Prisma.Decimal('12') },
        { id: 'soi-2', lineNumber: 2, qty: new Prisma.Decimal('100') },
      ],
      emitted: [],
      others: [],
      drafts: 0,
      orderStatus: 'CONFIRMED',
      orderEdits: [],
      updated: 1,
    };
  }

  function build(s: Scenario) {
    const audit = { write: jest.fn().mockResolvedValue(undefined) };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'doc-341', status: s.orderStatus }]),
      fiscalDocument: {
        findUnique: jest.fn().mockResolvedValue(s.document),
        // Primera llamada: notas de crédito; segunda: los que refacturaron las líneas.
        findMany: jest.fn().mockResolvedValueOnce(s.creditNotes).mockResolvedValueOnce(s.others),
        count: jest.fn().mockResolvedValue(s.drafts),
        updateMany: jest.fn().mockResolvedValue({ count: s.updated }),
      },
      auditLog: {
        findFirst: jest
          .fn()
          .mockResolvedValue(s.annulBefore === undefined ? null : { before: s.annulBefore }),
        findMany: jest.fn().mockResolvedValue(s.orderEdits),
      },
      customerPayment: { count: jest.fn().mockResolvedValue(s.payments) },
      salesOrderItem: { findMany: jest.fn().mockResolvedValue(s.orderItems) },
      fiscalDocumentItem: {
        groupBy: jest
          .fn()
          .mockResolvedValueOnce(
            s.emitted.map((e) => ({
              salesOrderItemId: e.salesOrderItemId,
              _sum: {
                qty: new Prisma.Decimal(e.qty),
                subtotalPen: new Prisma.Decimal(0),
                igvPen: new Prisma.Decimal(0),
                totalPen: new Prisma.Decimal(0),
              },
            })),
          )
          .mockResolvedValueOnce([]),
      },
    };
    const prisma = {
      $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const service = new FiscalImportService(prisma as never, audit as never);
    return { service, tx, audit, prisma };
  }

  it('reactiva: vuelve a ACCEPTED, vacía la anulación y la copia en la auditoría', async () => {
    const { service, tx, audit } = build(happy());

    await expect(service.reactivateExternal(ADMIN, 'doc-341', INPUT)).resolves.toEqual({
      id: 'doc-341',
      number: 'BBV1-00000341',
    });

    // La fila del comprobante, la del pedido y los borradores sobre sus líneas (revisiones cc07).
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.fiscalDocument.updateMany).toHaveBeenCalledWith({
      where: { id: 'doc-341', status: FiscalDocumentStatus.ANNULLED },
      data: {
        status: FiscalDocumentStatus.ACCEPTED,
        annulledAt: null,
        annulledById: null,
        annulReason: null,
      },
    });
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'invoicing.document.reactivate',
        entity: 'fiscal_documents',
        entityId: 'doc-341',
        reason: 'Anulado por error',
        before: {
          status: FiscalDocumentStatus.ANNULLED,
          statusBeforeAnnul: FiscalDocumentStatus.ACCEPTED,
          annulledAt: ANNULLED_AT.toISOString(),
          annulledById: 'admin-0',
          annulReason: 'mal despacho',
        },
        after: expect.objectContaining({
          status: FiscalDocumentStatus.ACCEPTED,
          confirmedStillValid: true,
        }) as unknown,
      }),
    );
  });

  it('un usuario no administrador no reactiva, y no abre la transacción', async () => {
    const { service, prisma } = build(happy());
    await expect(service.reactivateExternal(SELLER, 'doc-341', INPUT)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('sin la casilla «sigue vigente en Nubefact/SUNAT» no reactiva', async () => {
    const { service, prisma } = build(happy());
    await expect(
      service.reactivateExternal(ADMIN, 'doc-341', { ...INPUT, confirmStillValid: false }),
    ).rejects.toThrow(/Nubefact\/SUNAT/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('un comprobante emitido por el ERP (no manual) no se reactiva', async () => {
    const s = happy();
    s.document = { ...s.document, origin: FiscalDocumentOrigin.ISSUED_HERE };
    const { service, tx } = build(s);
    await expect(service.reactivateExternal(ADMIN, 'doc-341', INPUT)).rejects.toThrow(
      /lo emitió el ERP/,
    );
    expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
  });

  it('un comprobante inexistente da 404', async () => {
    const s = happy();
    s.document = null;
    const { service } = build(s);
    await expect(service.reactivateExternal(ADMIN, 'doc-341', INPUT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('uno ya vigente da 409 (segundo intento)', async () => {
    const s = happy();
    s.document = { ...s.document, status: FiscalDocumentStatus.ACCEPTED, annulledAt: null };
    const { service } = build(s);
    await expect(service.reactivateExternal(ADMIN, 'doc-341', INPUT)).rejects.toThrow(
      /ya está vigente/,
    );
  });

  it('una versión archivada no se reactiva', async () => {
    const s = happy();
    s.document = { ...s.document, archivedAt: new Date('2026-10-01T07:00:00Z') };
    const { service } = build(s);
    await expect(service.reactivateExternal(ADMIN, 'doc-341', INPUT)).rejects.toThrow(
      /reimportación/,
    );
  });

  it.each([
    ['sendAttempts', 1],
    ['providerTicket', 'T-1'],
    ['sunatHash', 'abc'],
    ['voidRequestedAt', new Date()],
    ['voidedAt', new Date()],
    ['lastAttemptAt', new Date()],
    ['providerResponse', { ok: true }],
    ['xmlKey', 'x.xml'],
    ['cdrKey', 'c.zip'],
  ])('bloquea con rastro de PSE o de baja (%s)', async (field, value) => {
    const s = happy();
    s.document = { ...s.document, [field]: value };
    const { service, tx } = build(s);
    await expect(service.reactivateExternal(ADMIN, 'doc-341', INPUT)).rejects.toThrow(
      /rastro de envío al PSE o de comunicación de baja/,
    );
    expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
  });

  it('sin el evento de anulación en la auditoría no reactiva', async () => {
    const s = happy();
    s.annulBefore = undefined;
    const { service } = build(s);
    await expect(service.reactivateExternal(ADMIN, 'doc-341', INPUT)).rejects.toThrow(
      /no tiene en la auditoría/,
    );
  });

  it('una anulación auditada desde un estado que no es aceptado no se reactiva', async () => {
    const s = happy();
    s.annulBefore = { status: FiscalDocumentStatus.ISSUED };
    const { service } = build(s);
    await expect(service.reactivateExternal(ADMIN, 'doc-341', INPUT)).rejects.toThrow(
      /no tiene en la auditoría/,
    );
  });

  it('un importado (no solo un manual) se reactiva', async () => {
    const s = happy();
    s.document = { ...s.document, origin: FiscalDocumentOrigin.IMPORTED };
    const { service, tx } = build(s);
    await service.reactivateExternal(ADMIN, 'doc-341', INPUT);
    expect(tx.fiscalDocument.updateMany).toHaveBeenCalledTimes(1);
  });

  it('bloquea con cobros vigentes o posteriores a la anulación', async () => {
    const s = happy();
    s.payments = 1;
    const { service, tx } = build(s);
    await expect(service.reactivateExternal(ADMIN, 'doc-341', INPUT)).rejects.toThrow(/cobros/);
    expect(tx.customerPayment.count).toHaveBeenCalledWith({
      where: {
        documentId: 'doc-341',
        OR: [{ reversedAt: null }, { createdAt: { gt: ANNULLED_AT } }],
      },
    });
    expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
  });

  it('bloquea con notas de crédito vivas o posteriores, y las nombra', async () => {
    const s = happy();
    s.creditNotes = [{ number: 'BBV1-00000900' }];
    const { service, tx } = build(s);
    await expect(service.reactivateExternal(ADMIN, 'doc-341', INPUT)).rejects.toThrow(
      /notas de crédito .*BBV1-00000900/,
    );
    expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
  });

  it('bloquea si las líneas ya se volvieron a facturar, y nombra el comprobante', async () => {
    const s = happy();
    s.emitted = [{ salesOrderItemId: 'soi-2', qty: '100' }];
    s.others = [{ number: 'BBV1-00000500' }];
    const { service, tx } = build(s);
    await expect(service.reactivateExternal(ADMIN, 'doc-341', INPUT)).rejects.toThrow(
      /La línea 2 del pedido ya se volvió a facturar en BBV1-00000500/,
    );
    expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
  });

  it('bloquea con borradores sobre las mismas líneas, sin borrarlos', async () => {
    const s = happy();
    s.drafts = 1;
    const { service, tx } = build(s);
    const err: unknown = await service
      .reactivateExternal(ADMIN, 'doc-341', INPUT)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/borrador.*PED-000048.*elimínalo/);
    expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
  });

  describe('vista previa (cc13: el detalle del pedido)', () => {
    it('si aplica, devuelve el comprobante sin escribir nada', async () => {
      const { service, tx, audit } = build(happy());
      await expect(service.previewReactivateExternal(ADMIN, 'doc-341')).resolves.toEqual({
        id: 'doc-341',
        number: 'BBV1-00000341',
      });
      expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('da el mismo bloqueo que la reactivación', async () => {
      const s = happy();
      s.drafts = 1;
      const { service } = build(s);
      await expect(service.previewReactivateExternal(ADMIN, 'doc-341')).rejects.toThrow(
        /borrador.*PED-000048.*elimínalo/,
      );
    });

    it('solo un administrador', async () => {
      const { service } = build(happy());
      await expect(service.previewReactivateExternal(SELLER, 'doc-341')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  it('si la fila cambió entre el lock y la escritura, no escribe auditoría', async () => {
    const s = happy();
    s.updated = 0;
    const { service, audit } = build(s);
    await expect(service.reactivateExternal(ADMIN, 'doc-341', INPUT)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('un estado que no es anulado ni vigente da 400', async () => {
    const s = happy();
    s.document = { ...s.document, status: FiscalDocumentStatus.DRAFT };
    const { service } = build(s);
    await expect(service.reactivateExternal(ADMIN, 'doc-341', INPUT)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('una nota de crédito anulada no se reactiva (revisión cc07, P1-1)', async () => {
    const s = happy();
    s.document = { ...s.document, docType: FiscalDocType.NOTA_CREDITO };
    const { service, tx } = build(s);
    await expect(service.reactivateExternal(ADMIN, 'doc-341', INPUT)).rejects.toThrow(
      /Solo se reactiva una factura o una boleta/,
    );
    expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
  });

  it('bloquea el pedido y los borradores de esas líneas antes de revisarlos (revisiones cc07)', async () => {
    const { service, tx } = build(happy());
    await service.reactivateExternal(ADMIN, 'doc-341', INPUT);
    const sqlOf = (n: number): string =>
      (tx.$queryRaw.mock.calls[n] as [TemplateStringsArray])[0].join('?');
    expect(sqlOf(1)).toMatch(/FROM "sales_orders" WHERE "id" = \?::uuid FOR UPDATE/);
    expect(tx.$queryRaw.mock.calls[1]).toContain('so-48');
    const sql = sqlOf(2);
    expect(sql).toMatch(/"status" = 'DRAFT'/);
    expect(sql).toMatch(/ORDER BY d\."id"\s+FOR UPDATE/);
    expect(tx.$queryRaw.mock.invocationCallOrder[2]).toBeLessThan(
      tx.fiscalDocument.count.mock.invocationCallOrder[0]!,
    );
  });

  it('un comprobante sin líneas de pedido se reactiva sin chequeo de líneas ni de borradores', async () => {
    const s = happy();
    s.document = {
      ...s.document,
      items: [{ qty: new Prisma.Decimal('1'), salesOrderItemId: null }],
    };
    const { service, tx } = build(s);
    await service.reactivateExternal(ADMIN, 'doc-341', INPUT);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.salesOrderItem.findMany).not.toHaveBeenCalled();
    expect(tx.fiscalDocument.count).not.toHaveBeenCalled();
    expect(tx.fiscalDocument.updateMany).toHaveBeenCalledTimes(1);
  });

  it('bloquea si el pedido está anulado (decisión del dueño)', async () => {
    const s = happy();
    s.orderStatus = 'CANCELLED';
    const { service, tx } = build(s);
    const err: unknown = await service
      .reactivateExternal(ADMIN, 'doc-341', INPUT)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toBe(
      'El pedido PED-000048 está anulado: no se reactiva un comprobante de un pedido anulado',
    );
    expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
  });

  it('bloquea si una línea que cubre el comprobante se editó después de la anulación', async () => {
    const s = happy();
    s.orderEdits = [{ before: { code: 'PED-000048', lineNumber: 2, qty: '100.000' } }];
    const { service, tx } = build(s);
    await expect(service.reactivateExternal(ADMIN, 'doc-341', INPUT)).rejects.toThrow(
      'El pedido PED-000048: la línea 2 se modificó (precio, producto o cantidad) después de anular BBV1-00000341',
    );
    // Lee las cuatro ediciones de línea del pedido, solo las posteriores a la anulación.
    expect(tx.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        entity: 'sales_orders',
        entityId: 'so-48',
        action: {
          in: [
            'sales.order.item-price',
            'sales.order.item-paper-amounts',
            'sales.order.item-coil',
            'sales.order.item-qty',
          ],
        },
        at: { gt: ANNULLED_AT },
      },
      select: { before: true },
    });
    expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
  });

  it('una edición de otra línea del pedido (o sin número de línea) no bloquea', async () => {
    const s = happy();
    s.orderEdits = [{ before: { lineNumber: 7 } }, { before: null }];
    const { service, tx } = build(s);
    await service.reactivateExternal(ADMIN, 'doc-341', INPUT);
    expect(tx.fiscalDocument.updateMany).toHaveBeenCalledTimes(1);
  });
});
