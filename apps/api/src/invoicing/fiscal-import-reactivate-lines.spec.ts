import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  FiscalDocType,
  FiscalDocumentOrigin,
  FiscalDocumentStatus,
  Prisma,
  Role,
} from '@prisma/client';
import { documentBalance } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { FiscalImportService } from './fiscal-import.service';

/**
 * D-378: reactivar un comprobante manual anulado con las líneas actuales del pedido. Cada bloqueo
 * se prueba partiendo de un caso que pasa todos (`happy`), para que un test en verde diga que
 * **ese** bloqueo es el que frena y no otro anterior.
 */
describe('FiscalImportService.reactivateWithOrderLines (D-378)', () => {
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
  // 118.00 de la línea original + 35.4354 de la agregada → gravada 130.03, IGV 23.41, 153.44.
  const INPUT = { reason: 'Faltó un ítem', confirmMatchesPaper: true, paperTotalPen: '153.44' };

  const dec = (v: string) => new Prisma.Decimal(v);
  /** El argumento `i` de la primera llamada a un mock. */
  const callArg = (mock: jest.Mock, i: number): unknown => (mock.mock.calls as unknown[][])[0]![i];

  interface Scenario {
    document: Record<string, unknown>;
    annulBefore: Prisma.JsonValue | undefined;
    payments: number;
    creditNotes: { number: string | null }[];
    order: { status: string; customer_id: string; seq: number } | undefined;
    orderLines: Record<string, unknown>[];
    others: { number: string | null }[];
    drafts: number;
    customer: { isSystem: boolean };
    updated: number;
  }

  function happy(): Scenario {
    return {
      document: {
        id: 'doc-1382',
        docType: FiscalDocType.FACTURA,
        number: 'FFA1-00001382',
        origin: FiscalDocumentOrigin.MANUAL,
        status: FiscalDocumentStatus.ANNULLED,
        archivedAt: null,
        annulledAt: ANNULLED_AT,
        annulledById: 'admin-0',
        annulReason: 'faltó un ítem',
        sendAttempts: 0,
        lastAttemptAt: null,
        providerTicket: null,
        providerResponse: null,
        sunatHash: null,
        xmlKey: null,
        cdrKey: null,
        voidRequestedAt: null,
        voidedAt: null,
        salesOrderId: 'so-11',
        salesOrder: { seq: 11 },
        customerId: 'cust-1',
        detractionCode: null,
        subtotalPen: dec('100'),
        igvPen: dec('18'),
        totalPen: dec('118'),
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
      },
      annulBefore: { status: FiscalDocumentStatus.ACCEPTED, totalPen: '118.0000' },
      payments: 0,
      creditNotes: [],
      order: { status: 'CONFIRMED', customer_id: 'cust-1', seq: 11 },
      orderLines: [
        {
          id: 'soi-1',
          lineNumber: 1,
          productId: 'p-1',
          description: 'Cobertura roja',
          qty: dec('48'),
          unit: 'MTR',
          subtotalPen: dec('100'),
          igvPen: dec('18'),
          totalPen: dec('118'),
        },
        {
          id: 'soi-2',
          lineNumber: 2,
          productId: 'p-2',
          description: 'Tornillo',
          qty: dec('3'),
          unit: 'NIU',
          subtotalPen: dec('30.03'),
          igvPen: dec('5.4054'),
          totalPen: dec('35.4354'),
        },
      ],
      others: [],
      drafts: 0,
      customer: { isSystem: false },
      updated: 1,
    };
  }

  function build(s: Scenario) {
    const audit = { write: jest.fn().mockResolvedValue(undefined) };
    // cc30: `lockDocuments` emite `SELECT "id" … = ANY($ids) … FOR UPDATE` y devuelve las filas
    // que existían; el mock las da todas por existentes. El pedido se lee después con Prisma.
    const queryRaw = jest.fn((_strings: TemplateStringsArray, ids?: unknown) =>
      Promise.resolve(Array.isArray(ids) ? ids.map((id: string) => ({ id })) : []),
    );
    // Lo que no es la lectura de ids de borradores (`draftIdsOn`, select id): primero notas de
    // crédito; después, otros comprobantes vivos del pedido.
    const lists = [s.creditNotes, s.others];
    const models = {
      $queryRaw: queryRaw,
      salesOrder: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            s.order
              ? { status: s.order.status, customerId: s.order.customer_id, seq: s.order.seq }
              : null,
          ),
      },
      fiscalDocument: {
        findUnique: jest.fn().mockResolvedValue(s.document),
        findMany: jest.fn((args: { select?: { id?: boolean } }) =>
          Promise.resolve(args.select?.id ? [] : (lists.shift() ?? [])),
        ),
        count: jest.fn().mockResolvedValue(s.drafts),
        updateMany: jest.fn().mockResolvedValue({ count: s.updated }),
      },
      fiscalDocumentItem: {
        update: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: {
        findFirst: jest
          .fn()
          .mockResolvedValue(s.annulBefore === undefined ? null : { before: s.annulBefore }),
      },
      customerPayment: { count: jest.fn().mockResolvedValue(s.payments) },
      salesOrderItem: { findMany: jest.fn().mockResolvedValue(s.orderLines) },
      customer: { findUnique: jest.fn().mockResolvedValue(s.customer) },
    };
    // Registra **qué modelos** toca la transacción: lo que no está en `models` (kardex,
    // reservas, despachos, cobros) revienta si alguien lo usa, y queda anotado.
    const touched = new Set<string>();
    const tx = new Proxy(models, {
      get(target, prop: string) {
        touched.add(prop);
        if (!(prop in target)) throw new Error(`La reactivación no debería tocar ${prop}`);
        return target[prop as keyof typeof target];
      },
    });
    const prisma = {
      $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const service = new FiscalImportService(prisma as never, audit as never);
    return { service, tx: models, audit, prisma, touched };
  }

  it('reactiva: ACCEPTED, cabecera nueva, la fila original en su lugar y la agregada al final', async () => {
    const { service, tx, audit } = build(happy());

    await expect(service.reactivateWithOrderLines(ADMIN, 'doc-1382', INPUT)).resolves.toEqual({
      id: 'doc-1382',
      number: 'FFA1-00001382',
    });

    expect(tx.fiscalDocument.updateMany).toHaveBeenCalledWith({
      where: { id: 'doc-1382', status: FiscalDocumentStatus.ANNULLED },
      data: {
        status: FiscalDocumentStatus.ACCEPTED,
        annulledAt: null,
        annulledById: null,
        annulReason: null,
        subtotalPen: '130.0300',
        igvPen: '23.4100',
        totalPen: '153.4400',
      },
    });
    // Ni número, ni serie, ni fecha, ni cliente: la escritura de la cabecera no los nombra.
    const data = (callArg(tx.fiscalDocument.updateMany, 0) as { data: object }).data;
    for (const kept of ['number', 'seriesId', 'correlative', 'issueDate', 'customerId']) {
      expect(data).not.toHaveProperty(kept);
    }
    expect(tx.fiscalDocumentItem.update).toHaveBeenCalledWith({
      where: { id: 'fdi-1' },
      data: {
        productId: 'p-1',
        // D-381: el plan dice a qué línea apunta la fila; en D-378 es la misma de antes.
        salesOrderItemId: 'soi-1',
        description: 'Cobertura roja (papel)',
        unit: 'MTR',
        qty: '48.000',
        unitPricePen: '2.0833',
        subtotalPen: '100.0000',
        igvPen: '18.0000',
        totalPen: '118.0000',
      },
    });
    expect(tx.fiscalDocumentItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          documentId: 'doc-1382',
          lineNumber: 2,
          salesOrderItemId: 'soi-2',
          qty: '3.000',
          totalPen: '35.4354',
        }),
      ],
    });

    expect(audit.write).toHaveBeenCalledTimes(1);
    const event = callArg(audit.write, 1) as {
      action: string;
      reason: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(event.action).toBe('invoicing.document.reactivate-with-order-lines');
    expect(event.reason).toBe('Faltó un ítem');
    expect(event.before).toMatchObject({
      status: FiscalDocumentStatus.ANNULLED,
      statusBeforeAnnul: FiscalDocumentStatus.ACCEPTED,
      annulledAt: ANNULLED_AT.toISOString(),
      annulReason: 'faltó un ítem',
      totalPen: '118.0000',
    });
    expect((event.before.lines as unknown[]).length).toBe(1);
    expect(event.after).toMatchObject({
      status: FiscalDocumentStatus.ACCEPTED,
      confirmedMatchesPaper: true,
      paperTotalPen: '153.44',
      totalPen: '153.4400',
    });
    expect((event.after.lines as unknown[]).length).toBe(2);
  });

  it('no mueve el kardex ni toca reservas, despachos ni cobros: solo el comprobante, sus líneas y la auditoría', async () => {
    const { service, tx, touched } = build(happy());
    await service.reactivateWithOrderLines(ADMIN, 'doc-1382', INPUT);

    // El único uso de cobros es el conteo del bloqueo; nada los escribe.
    expect(tx.customerPayment.count).toHaveBeenCalledTimes(1);
    for (const model of [
      'inventoryMovement',
      'reservation',
      'dispatch',
      'dispatchItem',
      'stockBalance',
      'coil',
    ]) {
      expect(touched.has(model)).toBe(false);
    }
    expect([...touched].sort()).toEqual(
      [
        '$queryRaw',
        'auditLog',
        'customer',
        'customerPayment',
        'fiscalDocument',
        'fiscalDocumentItem',
        // cc30: el pedido (ya bloqueado por la puerta) se lee con Prisma; solo lectura.
        'salesOrder',
        'salesOrderItem',
      ].sort(),
    );
    expect(tx.salesOrder.findUnique).toHaveBeenCalledTimes(1);
  });

  it('el saldo por cobrar queda igual al total nuevo (sin cobros ni notas de crédito)', async () => {
    const { service, tx } = build(happy());
    await service.reactivateWithOrderLines(ADMIN, 'doc-1382', INPUT);
    const data = (
      callArg(tx.fiscalDocument.updateMany, 0) as {
        data: { status: FiscalDocumentStatus; totalPen: string };
      }
    ).data;
    expect(
      documentBalance({
        status: data.status,
        totalPen: data.totalPen,
        paidPen: '0',
        creditedPen: '0',
      }),
    ).toBe('153.4400');
  });

  it('total del papel distinto: rechaza mostrando los dos y la diferencia, y no escribe nada', async () => {
    const { service, tx, audit } = build(happy());
    const err = await service
      .reactivateWithOrderLines(ADMIN, 'doc-1382', { ...INPUT, paperTotalPen: '153.45' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe(
      'El total del papel (S/ 153.45) no coincide con el de estas líneas (S/ 153.44): diferencia S/ 0.01. Revisa el pedido o el papel; no se reactivó',
    );
    expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
    expect(tx.fiscalDocumentItem.update).not.toHaveBeenCalled();
    expect(tx.fiscalDocumentItem.createMany).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('sin la casilla «coincide con el papel vigente» no abre la transacción', async () => {
    const { service, prisma } = build(happy());
    await expect(
      service.reactivateWithOrderLines(ADMIN, 'doc-1382', { ...INPUT, confirmMatchesPaper: false }),
    ).rejects.toThrow(
      'Confirma que el comprobante, con estas líneas, coincide con el papel vigente antes de reactivarlo',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('solo un administrador, también en la vista previa', async () => {
    const { service } = build(happy());
    await expect(service.reactivateWithOrderLines(SELLER, 'doc-1382', INPUT)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.previewReactivationWithOrderLines(SELLER, 'doc-1382')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('la vista previa devuelve el antes y el después sin escribir nada', async () => {
    const { service, tx, audit } = build(happy());
    const preview = await service.previewReactivationWithOrderLines(ADMIN, 'doc-1382');
    expect(preview).toMatchObject({
      id: 'doc-1382',
      number: 'FFA1-00001382',
      salesOrderCode: 'PED-000011',
      before: { totalPen: '118.0000' },
      after: { subtotalPen: '130.0300', igvPen: '23.4100', totalPen: '153.4400' },
    });
    expect(preview.after.lines.map((l) => l.added)).toEqual([false, true]);
    expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
    expect(tx.fiscalDocumentItem.update).not.toHaveBeenCalled();
    expect(tx.fiscalDocumentItem.createMany).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  describe('bloqueos', () => {
    async function rejects(s: Scenario, type: unknown, message: string | RegExp) {
      const { service, tx, audit } = build(s);
      const err = await service
        .reactivateWithOrderLines(ADMIN, 'doc-1382', INPUT)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(type as never);
      expect((err as Error).message).toMatch(message);
      expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
      expect(tx.fiscalDocumentItem.update).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    }

    it('otro comprobante vivo en el pedido, con su número', async () => {
      const s = happy();
      s.others = [{ number: 'FFA1-00001400' }];
      await rejects(
        s,
        ConflictException,
        'El pedido PED-000011 tiene otro comprobante vivo (FFA1-00001400): con las líneas del pedido, FFA1-00001382 facturaría dos veces lo que ese ya factura. Decide cuál queda antes de reactivar',
      );
    });

    it('un borrador en el pedido', async () => {
      const s = happy();
      s.drafts = 1;
      await rejects(
        s,
        ConflictException,
        'El pedido PED-000011 tiene 1 borrador(es) de comprobante: elimínalo(s) primero y vuelve a reactivar',
      );
    });

    it('un comprobante importado: con las líneas del pedido solo se reactiva un manual', async () => {
      const s = happy();
      s.document.origin = FiscalDocumentOrigin.IMPORTED;
      await rejects(s, BadRequestException, /no es un comprobante manual/);
    });

    it('un comprobante emitido por el ERP (bloqueo común de D-373)', async () => {
      const s = happy();
      s.document.origin = FiscalDocumentOrigin.ISSUED_HERE;
      await rejects(s, BadRequestException, /lo emitió el ERP/);
    });

    it('cobros vigentes o posteriores a la anulación (bloqueo común de D-373)', async () => {
      const s = happy();
      s.payments = 1;
      await rejects(s, BadRequestException, /tiene cobros vigentes/);
    });

    it('notas de crédito (bloqueo común de D-373)', async () => {
      const s = happy();
      s.creditNotes = [{ number: 'FC01-00000009' }];
      await rejects(s, BadRequestException, /notas de crédito vivas/);
    });

    it('el pedido describe lo mismo que el comprobante: corresponde la reactivación simple', async () => {
      const s = happy();
      s.orderLines = [s.orderLines[0]!];
      await rejects(
        s,
        BadRequestException,
        'Las líneas del pedido PED-000011 son las mismas de FFA1-00001382: no hay nada que cambiar. Usa «Reactivar»',
      );
    });

    it('el pedido cambió de cliente', async () => {
      const s = happy();
      s.order = { status: 'CONFIRMED', customer_id: 'cust-2', seq: 11 };
      await rejects(s, ConflictException, /cambió de cliente después de anular FFA1-00001382/);
    });

    it('el pedido está anulado', async () => {
      const s = happy();
      s.order = { status: 'CANCELLED', customer_id: 'cust-1', seq: 11 };
      await rejects(s, ConflictException, /PED-000011 está anulado/);
    });

    it('detracción (decisión 4)', async () => {
      const s = happy();
      s.document.detractionCode = '037';
      await rejects(s, BadRequestException, /tiene detracción/);
    });

    it('una línea que no viene del pedido', async () => {
      const s = happy();
      const items = s.document.items as Record<string, unknown>[];
      items[0]!.salesOrderItemId = null;
      await rejects(s, BadRequestException, /líneas que no vienen del pedido/);
    });

    it('sin pedido', async () => {
      const s = happy();
      s.document.salesOrderId = null;
      await rejects(s, BadRequestException, /no es de un pedido/);
    });

    it('una boleta a público en general que cruzaría el tope', async () => {
      const s = happy();
      s.customer = { isSystem: true };
      const lines = s.orderLines;
      lines[1] = {
        ...lines[1]!,
        subtotalPen: dec('600'),
        igvPen: dec('108'),
        totalPen: dec('708'),
      };
      await rejects(s, BadRequestException, /el tope de una boleta a «público en general»/);
    });

    it('un comprobante vigente: 409, ya está vigente (idempotencia)', async () => {
      const s = happy();
      s.document.status = FiscalDocumentStatus.ACCEPTED;
      await rejects(s, ConflictException, 'FFA1-00001382 ya está vigente');
    });

    it('si el estado cambió entre el lock y la escritura, no toca ninguna línea', async () => {
      const s = happy();
      s.updated = 0;
      const { service, tx, audit } = build(s);
      await expect(service.reactivateWithOrderLines(ADMIN, 'doc-1382', INPUT)).rejects.toThrow(
        ConflictException,
      );
      expect(tx.fiscalDocumentItem.update).not.toHaveBeenCalled();
      expect(tx.fiscalDocumentItem.createMany).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });
  });
});
