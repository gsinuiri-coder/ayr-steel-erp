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
import { documentBalance } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { MOVABLE_CANDIDATES_LIMIT, MoveDocumentToOrderService } from './move-to-order.service';

/**
 * D-381: traer un comprobante manual anulado a otro pedido. Cada bloqueo se prueba partiendo de
 * un caso que pasa todos (`happy`), para que un test en verde diga que **ese** bloqueo es el que
 * frena y no otro anterior. El caso imita a FFA1-00001389: al pedido de origen (anulado) le
 * faltaba una línea, que el destino tiene como línea 1.
 */
describe('MoveDocumentToOrderService (D-381)', () => {
  const ADMIN: RequestUser = {
    id: 'admin-1',
    email: 'admin@ayr.test',
    name: 'Admin',
    role: Role.ADMINISTRADOR,
    mustChangePassword: false,
    sessionId: 'session-1',
  };
  const SELLER: RequestUser = { ...ADMIN, id: 'seller-1', role: Role.VENDEDOR };
  const ANNULLED_AT = new Date('2026-09-29T04:52:30.404Z');
  const SOURCE = '00000000-0000-4000-8000-000000000044';
  const TARGET = '00000000-0000-4000-8000-000000000056';
  // Dos líneas de 11.80 que ya estaban + 35.40 de la nueva → gravada 50.00, IGV 9.00, total 59.00.
  const INPUT = {
    reason: 'Pedido con datos erróneos',
    confirmMatchesPaper: true,
    paperTotalPen: '59.00',
    targetSalesOrderId: TARGET,
  };

  const dec = (v: string) => new Prisma.Decimal(v);
  const callArg = (mock: jest.Mock, call: number, i: number): unknown =>
    (mock.mock.calls as unknown[][])[call]![i];

  const docItem = (id: string, lineNumber: number, productId: string, soi: string) => ({
    id,
    lineNumber,
    productId,
    description: `Papel ${productId}`,
    qty: dec('1'),
    unit: 'NIU',
    unitPricePen: dec('10'),
    subtotalPen: dec('10'),
    igvPen: dec('1.8'),
    totalPen: dec('11.8'),
    salesOrderItemId: soi,
  });
  const orderLine = (id: string, lineNumber: number, productId: string, total = '11.8') => ({
    id,
    lineNumber,
    productId,
    description: `Pedido ${productId}`,
    qty: dec(total === '11.8' ? '1' : '3'),
    unit: 'NIU',
    subtotalPen: dec(total === '11.8' ? '10' : '30'),
    igvPen: dec(total === '11.8' ? '1.8' : '5.4'),
    totalPen: dec(total),
  });

  interface OrderRow {
    id: string;
    status: string;
    customer_id: string;
    seq: number;
    issue_date: Date;
    seller_id: string | null;
  }

  interface Scenario {
    document: Record<string, unknown>;
    annulBefore: Prisma.JsonValue | undefined;
    payments: number;
    creditNotes: { number: string | null }[];
    anyCreditNotes: number;
    orders: OrderRow[];
    linkedDispatches: { seq: number }[];
    liveSourceDispatches: { seq: number }[];
    targetLines: Record<string, unknown>[];
    sourceLines: { id: string; lineNumber: number }[];
    others: { number: string | null }[];
    drafts: number;
    customer: { isSystem: boolean };
    updated: number;
  }

  function happy(): Scenario {
    return {
      document: {
        id: 'doc-1389',
        docType: FiscalDocType.FACTURA,
        number: 'FFA1-00001389',
        origin: FiscalDocumentOrigin.MANUAL,
        status: FiscalDocumentStatus.ANNULLED,
        archivedAt: null,
        annulledAt: ANNULLED_AT,
        annulledById: 'admin-0',
        annulReason: 'mal ingreso',
        sendAttempts: 0,
        lastAttemptAt: null,
        providerTicket: null,
        providerResponse: null,
        sunatHash: null,
        xmlKey: null,
        cdrKey: null,
        voidRequestedAt: null,
        voidedAt: null,
        salesOrderId: SOURCE,
        salesOrder: { seq: 44 },
        issueDate: new Date('2026-08-20T00:00:00.000Z'),
        customerId: 'cust-1',
        detractionCode: null,
        subtotalPen: dec('20'),
        igvPen: dec('3.6'),
        totalPen: dec('23.6'),
        items: [docItem('fdi-1', 1, 'p-a', 'src-1'), docItem('fdi-2', 2, 'p-b', 'src-2')],
      },
      annulBefore: { status: FiscalDocumentStatus.ACCEPTED, totalPen: '23.6000' },
      payments: 0,
      creditNotes: [],
      anyCreditNotes: 0,
      orders: [
        {
          id: SOURCE,
          status: 'CANCELLED',
          customer_id: 'cust-1',
          seq: 44,
          issue_date: new Date('2026-09-28T00:00:00.000Z'),
          seller_id: 'seller-old',
        },
        {
          id: TARGET,
          status: 'CONFIRMED',
          customer_id: 'cust-1',
          seq: 56,
          issue_date: new Date('2026-10-01T00:00:00.000Z'),
          seller_id: 'seller-new',
        },
      ],
      linkedDispatches: [],
      liveSourceDispatches: [],
      targetLines: [
        orderLine('dst-1', 1, 'p-nuevo', '35.4'),
        orderLine('dst-2', 2, 'p-a'),
        orderLine('dst-3', 3, 'p-b'),
      ],
      sourceLines: [
        { id: 'src-1', lineNumber: 1 },
        { id: 'src-2', lineNumber: 2 },
      ],
      others: [],
      drafts: 0,
      customer: { isSystem: false },
      updated: 1,
    };
  }

  function build(s: Scenario) {
    const audit = { write: jest.fn().mockResolvedValue(undefined) };
    const queryRaw = jest.fn((strings: TemplateStringsArray) =>
      Promise.resolve(strings.join('?').includes('"sales_orders"') ? s.orders : []),
    );
    const models = {
      $queryRaw: queryRaw,
      fiscalDocument: {
        findUnique: jest.fn().mockResolvedValue(s.document),
        // Primera llamada: notas de crédito vivas (lock común); segunda: otros vivos del destino.
        findMany: jest.fn().mockResolvedValueOnce(s.creditNotes).mockResolvedValueOnce(s.others),
        // Primera: cualquier nota de crédito; segunda: borradores del destino.
        count: jest.fn().mockResolvedValueOnce(s.anyCreditNotes).mockResolvedValueOnce(s.drafts),
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
      // Primera: enlazados al comprobante; segunda: vigentes del pedido de origen.
      dispatch: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(s.linkedDispatches)
          .mockResolvedValueOnce(s.liveSourceDispatches),
      },
      salesOrderItem: {
        findMany: jest.fn((args: { where: { salesOrderId: string } }) =>
          Promise.resolve(args.where.salesOrderId === TARGET ? s.targetLines : s.sourceLines),
        ),
      },
      customer: { findUnique: jest.fn().mockResolvedValue(s.customer) },
      user: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'seller-old', name: 'Vendedor viejo' },
          { id: 'seller-new', name: 'Vendedor nuevo' },
        ]),
      },
    };
    // Registra **qué modelos** toca la transacción: lo que no está en `models` (kardex,
    // reservas, cobros) revienta si alguien lo usa, y queda anotado.
    const touched = new Set<string>();
    const tx = new Proxy(models, {
      get(target, prop: string) {
        touched.add(prop);
        if (!(prop in target)) throw new Error(`Traer el comprobante no debería tocar ${prop}`);
        return target[prop as keyof typeof target];
      },
    });
    const prisma = {
      $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const service = new MoveDocumentToOrderService(prisma as never, audit as never);
    return { service, tx: models, audit, prisma, touched };
  }

  it('lo trae: ACCEPTED en el pedido destino, cabecera nueva, filas en su lugar apuntando al destino y la nueva al final', async () => {
    const { service, tx } = build(happy());

    await expect(service.move(ADMIN, 'doc-1389', INPUT)).resolves.toEqual({
      id: 'doc-1389',
      number: 'FFA1-00001389',
    });

    // Condicionado al estado y al pedido de origen: si otra transacción cambió uno, no escribe.
    expect(tx.fiscalDocument.updateMany).toHaveBeenCalledWith({
      where: { id: 'doc-1389', status: FiscalDocumentStatus.ANNULLED, salesOrderId: SOURCE },
      data: {
        status: FiscalDocumentStatus.ACCEPTED,
        annulledAt: null,
        annulledById: null,
        annulReason: null,
        salesOrderId: TARGET,
        subtotalPen: '50.0000',
        igvPen: '9.0000',
        totalPen: '59.0000',
      },
    });
    // Ni número, ni serie, ni fecha, ni cliente, ni vencimiento: son los del papel.
    const data = (callArg(tx.fiscalDocument.updateMany, 0, 0) as { data: object }).data;
    for (const kept of [
      'number',
      'seriesId',
      'correlative',
      'issueDate',
      'customerId',
      'dueDate',
      'paymentTerms',
    ]) {
      expect(data).not.toHaveProperty(kept);
    }

    // P1 de la revisión del diseño: cada fila apunta a la línea del pedido destino.
    const updates = (tx.fiscalDocumentItem.update.mock.calls as unknown[][]).map(
      (c) => c[0] as { where: { id: string }; data: { salesOrderItemId: string } },
    );
    expect(updates.map((u) => [u.where.id, u.data.salesOrderItemId])).toEqual([
      ['fdi-1', 'dst-2'],
      ['fdi-2', 'dst-3'],
    ]);
    expect(tx.fiscalDocumentItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          documentId: 'doc-1389',
          lineNumber: 3,
          salesOrderItemId: 'dst-1',
          productId: 'p-nuevo',
          totalPen: '35.4000',
        }),
      ],
    });
  });

  it('auditoría con origen y destino: el comprobante y los dos pedidos', async () => {
    const { service, audit } = build(happy());
    await service.move(ADMIN, 'doc-1389', INPUT);

    expect(audit.write).toHaveBeenCalledTimes(3);
    const events = (audit.write.mock.calls as unknown[][]).map(
      (c) =>
        c[1] as {
          action: string;
          entity: string;
          entityId: string;
          reason: string;
          before: Record<string, unknown>;
          after: Record<string, unknown>;
        },
    );
    const [doc, out, into] = events;
    expect(doc!.action).toBe('invoicing.document.move-to-order');
    expect(doc!.entityId).toBe('doc-1389');
    expect(doc!.reason).toBe('Pedido con datos erróneos');
    expect(doc!.before).toMatchObject({
      status: FiscalDocumentStatus.ANNULLED,
      statusBeforeAnnul: FiscalDocumentStatus.ACCEPTED,
      annulReason: 'mal ingreso',
      salesOrderId: SOURCE,
      salesOrderCode: 'PED-000044',
      seller: { id: 'seller-old', name: 'Vendedor viejo' },
      totalPen: '23.6000',
    });
    // El antes conserva qué línea de origen facturaba cada fila.
    expect(doc!.before.rows).toEqual([
      { id: 'fdi-1', lineNumber: 1, productId: 'p-a', salesOrderItemId: 'src-1' },
      { id: 'fdi-2', lineNumber: 2, productId: 'p-b', salesOrderItemId: 'src-2' },
    ]);
    expect(doc!.after).toMatchObject({
      status: FiscalDocumentStatus.ACCEPTED,
      number: 'FFA1-00001389',
      issueDate: '2026-08-20',
      orderIssueDate: '2026-10-01',
      salesOrderId: TARGET,
      salesOrderCode: 'PED-000056',
      seller: { id: 'seller-new', name: 'Vendedor nuevo' },
      confirmedMatchesPaper: true,
      paperTotalPen: '59.00',
      totalPen: '59.0000',
    });
    expect(doc!.after.rows).toEqual([
      { id: 'fdi-1', productId: 'p-a', salesOrderItemId: 'dst-2' },
      { id: 'fdi-2', productId: 'p-b', salesOrderItemId: 'dst-3' },
      { lineNumber: 3, productId: 'p-nuevo', salesOrderItemId: 'dst-1' },
    ]);

    expect([out!.action, out!.entity, out!.entityId]).toEqual([
      'sales.order.document-moved-out',
      'sales_orders',
      SOURCE,
    ]);
    expect([into!.action, into!.entity, into!.entityId]).toEqual([
      'sales.order.document-moved-in',
      'sales_orders',
      TARGET,
    ]);
    for (const e of [out!, into!]) {
      expect(e.before).toMatchObject({ documentId: 'doc-1389', salesOrderId: SOURCE });
      expect(e.after).toMatchObject({ documentId: 'doc-1389', salesOrderId: TARGET });
    }
  });

  it('no mueve el kardex ni toca reservas ni cobros; los despachos solo se leen', async () => {
    const { service, tx, touched } = build(happy());
    await service.move(ADMIN, 'doc-1389', INPUT);

    // El único uso de cobros es el conteo del bloqueo; nada los escribe.
    expect(tx.customerPayment.count).toHaveBeenCalledTimes(1);
    for (const model of [
      'inventoryMovement',
      'reservation',
      'dispatchItem',
      'stockBalance',
      'coil',
    ]) {
      expect(touched.has(model)).toBe(false);
    }
    // `dispatch` solo tiene `findMany` en el mock: cualquier escritura reventaría.
    expect(Object.keys(tx.dispatch)).toEqual(['findMany']);
    expect([...touched].sort()).toEqual(
      [
        '$queryRaw',
        'auditLog',
        'customer',
        'customerPayment',
        'dispatch',
        'fiscalDocument',
        'fiscalDocumentItem',
        'salesOrderItem',
        'user',
      ].sort(),
    );
  });

  it('el saldo por cobrar queda igual al total nuevo', async () => {
    const { service, tx } = build(happy());
    await service.move(ADMIN, 'doc-1389', INPUT);
    const data = (
      callArg(tx.fiscalDocument.updateMany, 0, 0) as {
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
    ).toBe('59.0000');
  });

  it('total del papel distinto: rechaza mostrando los dos y la diferencia, y no escribe nada', async () => {
    const { service, tx, audit } = build(happy());
    const err = await service
      .move(ADMIN, 'doc-1389', { ...INPUT, paperTotalPen: '23.60' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe(
      'El total del papel (S/ 23.60) no coincide con el de estas líneas (S/ 59.00): diferencia S/ -35.40. Revisa el pedido o el papel; no se trajo el comprobante',
    );
    expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
    expect(tx.fiscalDocumentItem.update).not.toHaveBeenCalled();
    expect(tx.fiscalDocumentItem.createMany).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('sin la casilla no abre la transacción', async () => {
    const { service, prisma } = build(happy());
    await expect(
      service.move(ADMIN, 'doc-1389', { ...INPUT, confirmMatchesPaper: false }),
    ).rejects.toThrow('coincide con el papel vigente antes de traerlo');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('solo un administrador, también en la vista previa y la lista', async () => {
    const { service } = build(happy());
    await expect(service.move(SELLER, 'doc-1389', INPUT)).rejects.toThrow(ForbiddenException);
    await expect(service.preview(SELLER, 'doc-1389', TARGET)).rejects.toThrow(ForbiddenException);
    await expect(service.candidates(SELLER, TARGET)).rejects.toThrow(ForbiddenException);
  });

  it('si otra transacción lo cambió entre el plan y la escritura, no toca ninguna línea', async () => {
    const s = happy();
    s.updated = 0;
    const { service, tx, audit } = build(s);
    await expect(service.move(ADMIN, 'doc-1389', INPUT)).rejects.toThrow(
      'FFA1-00001389 cambió mientras se traía: vuelve a intentarlo',
    );
    expect(tx.fiscalDocumentItem.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('la vista previa: antes y después, pedidos, vendedores y avisos; no escribe nada', async () => {
    const { service, tx, audit } = build(happy());
    const preview = await service.preview(ADMIN, 'doc-1389', TARGET);
    expect(preview).toMatchObject({
      id: 'doc-1389',
      number: 'FFA1-00001389',
      issueDate: '2026-08-20',
      sourceOrderCode: 'PED-000044',
      targetOrderCode: 'PED-000056',
      targetOrderIssueDate: '2026-10-01',
      sellerBefore: { id: 'seller-old', name: 'Vendedor viejo' },
      sellerAfter: { id: 'seller-new', name: 'Vendedor nuevo' },
      before: { totalPen: '23.6000' },
      after: { subtotalPen: '50.0000', igvPen: '9.0000', totalPen: '59.0000' },
    });
    expect(preview.before.lines.map((l) => l.orderLineNumber)).toEqual([1, 2]);
    expect(preview.after.lines.map((l) => [l.lineNumber, l.orderLineNumber, l.added])).toEqual([
      [1, 2, false],
      [2, 3, false],
      [3, 1, true],
    ]);
    // Decisión 3 del dueño: se permite y se avisa. Y el despacho a la fecha del papel (D-374).
    expect(preview.warnings).toEqual([
      'El comprobante (20/08/2026) es anterior al pedido PED-000056 (01/10/2026): se conserva la fecha del papel',
      expect.stringContaining('Despachar desde el comprobante usa la fecha del papel (20/08/2026)'),
    ]);
    expect(preview.warnings[1]).toContain('D-374');
    expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
    expect(tx.fiscalDocumentItem.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('sin aviso de fecha si el papel no es anterior al pedido destino', async () => {
    const s = happy();
    s.document.issueDate = new Date('2026-10-01T00:00:00.000Z');
    const { service } = build(s);
    const preview = await service.preview(ADMIN, 'doc-1389', TARGET);
    expect(preview.warnings).toHaveLength(1);
    expect(preview.warnings[0]).toContain('Despachar desde el comprobante');
  });

  it('una fila que cambia de producto al emparejarse sale marcada en el después', async () => {
    const s = happy();
    s.targetLines = [orderLine('dst-1', 1, 'p-a'), orderLine('dst-2', 2, 'p-otro')];
    const { service } = build(s);
    const preview = await service.preview(ADMIN, 'doc-1389', TARGET);
    expect(preview.after.lines.map((l) => [l.lineNumber, l.productChanged ?? false])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  describe('bloqueos', () => {
    async function rejects(s: Scenario, type: unknown, message: string | RegExp) {
      const { service, tx, audit } = build(s);
      const err = await service.move(ADMIN, 'doc-1389', INPUT).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(type as never);
      expect((err as Error).message).toMatch(message);
      expect(tx.fiscalDocument.updateMany).not.toHaveBeenCalled();
      expect(tx.fiscalDocumentItem.update).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    }

    it('ya vigente: idempotencia de la transición', async () => {
      const s = happy();
      s.document.status = FiscalDocumentStatus.ACCEPTED;
      await rejects(s, ConflictException, 'FFA1-00001389 ya está vigente');
    });

    it('cobros vigentes o posteriores a la anulación', async () => {
      const s = happy();
      s.payments = 1;
      await rejects(s, BadRequestException, /tiene cobros vigentes/);
    });

    it('notas de crédito vivas o posteriores a la anulación', async () => {
      const s = happy();
      s.creditNotes = [{ number: 'FC01-00000001' }];
      await rejects(s, BadRequestException, /notas de crédito vivas o posteriores/);
    });

    it('cualquier nota de crédito, aunque ya no esté viva', async () => {
      const s = happy();
      s.anyCreditNotes = 1;
      await rejects(
        s,
        ConflictException,
        'FFA1-00001389 tiene notas de crédito (aunque no estén vivas): no se trae a otro pedido',
      );
    });

    it('origen no manual', async () => {
      const s = happy();
      s.document.origin = FiscalDocumentOrigin.IMPORTED;
      await rejects(s, BadRequestException, 'solo un manual se trae a otro pedido');
    });

    it('con detracción', async () => {
      const s = happy();
      s.document.detractionCode = '037';
      await rejects(s, BadRequestException, /tiene detracción/);
    });

    it('líneas que no vienen del pedido', async () => {
      const s = happy();
      (s.document.items as { salesOrderItemId: string | null }[])[0]!.salesOrderItemId = null;
      await rejects(s, BadRequestException, /líneas que no vienen del pedido/);
    });

    it('el destino es su propio pedido', async () => {
      const s = happy();
      s.document.salesOrderId = TARGET;
      await rejects(s, BadRequestException, /ya es de este pedido: usa «Reactivar»/);
    });

    it('decisión 2: el pedido de origen no está anulado', async () => {
      const s = happy();
      s.orders[0]!.status = 'CONFIRMED';
      await rejects(
        s,
        ConflictException,
        /El pedido de origen PED-000044 no está anulado: .*«Reactivar con las líneas del pedido»/,
      );
    });

    it('el pedido destino está anulado', async () => {
      const s = happy();
      s.orders[1]!.status = 'CANCELLED';
      await rejects(s, ConflictException, 'El pedido PED-000056 está anulado');
    });

    it('decisión 1: el pedido destino es de otro cliente', async () => {
      const s = happy();
      s.orders[1]!.customer_id = 'cust-2';
      await rejects(s, ConflictException, /El pedido PED-000056 es de otro cliente/);
    });

    it('un pedido que no existe', async () => {
      const s = happy();
      s.orders = [s.orders[0]!];
      await rejects(s, NotFoundException, 'Pedido no encontrado');
    });

    it('despachos enlazados al comprobante, aunque estén revertidos', async () => {
      const s = happy();
      s.linkedDispatches = [{ seq: 35 }];
      await rejects(s, ConflictException, 'FFA1-00001389 tiene despachos enlazados (DES-000035)');
    });

    it('despachos vigentes del pedido de origen', async () => {
      const s = happy();
      s.liveSourceDispatches = [{ seq: 40 }];
      await rejects(
        s,
        ConflictException,
        /El pedido de origen PED-000044 tiene despachos vigentes \(DES-000040\)/,
      );
    });

    it('otro comprobante vivo en el pedido destino, con su número', async () => {
      const s = happy();
      s.others = [{ number: 'FFA1-00001400' }];
      await rejects(
        s,
        ConflictException,
        /El pedido PED-000056 tiene otro comprobante vivo \(FFA1-00001400\)/,
      );
    });

    it('un borrador en el pedido destino', async () => {
      const s = happy();
      s.drafts = 1;
      await rejects(
        s,
        ConflictException,
        'El pedido PED-000056 tiene 1 borrador(es) de comprobante: elimínalo(s) primero y vuelve a intentarlo',
      );
    });

    it('el destino tiene menos líneas que el comprobante: no se borra ninguna fila', async () => {
      const s = happy();
      s.targetLines = [orderLine('dst-2', 1, 'p-a')];
      await rejects(
        s,
        ConflictException,
        'El pedido PED-000056 tiene 1 línea(s) y FFA1-00001389 tiene 2: no se borra ninguna línea del comprobante. Agrega al pedido lo que falta',
      );
    });

    it('D-077: una boleta a «público en general» que cruzaría el tope', async () => {
      const s = happy();
      s.customer = { isSystem: true };
      s.targetLines = [
        {
          ...orderLine('dst-1', 1, 'p-nuevo'),
          subtotalPen: dec('700'),
          igvPen: dec('126'),
          totalPen: dec('826'),
        },
        orderLine('dst-2', 2, 'p-a'),
        orderLine('dst-3', 3, 'p-b'),
      ];
      await rejects(s, BadRequestException, /el tope de una boleta a «público en general»/);
    });
  });

  describe('candidatos (sin bloqueos)', () => {
    function buildList(docs: Record<string, unknown>[]) {
      const s = happy();
      const built = build(s);
      const findManyDocs = jest.fn().mockResolvedValue(docs);
      const prisma = {
        salesOrder: { findUnique: jest.fn().mockResolvedValue({ customerId: 'cust-1' }) },
        fiscalDocument: { findMany: findManyDocs },
      };
      // Las comprobaciones por candidato corren sobre el cliente de Prisma sin transacción: se
      // les da el mismo `tx` simulado.
      Object.assign(built.prisma, prisma);
      const reader = new Proxy(built.tx, {
        get(target, prop: string) {
          if (prop === 'salesOrder') return prisma.salesOrder;
          if (prop === 'fiscalDocument' && findManyDocs.mock.calls.length === 0) {
            return prisma.fiscalDocument;
          }
          return target[prop as keyof typeof target];
        },
      });
      const service = new MoveDocumentToOrderService(reader as never, built.audit as never);
      return { service, findManyDocs, queryRaw: built.tx.$queryRaw };
    }

    const candidate = {
      id: 'doc-1389',
      number: 'FFA1-00001389',
      docType: FiscalDocType.FACTURA,
      issueDate: new Date('2026-08-20T00:00:00.000Z'),
      totalPen: dec('23.6'),
      salesOrderId: SOURCE,
      salesOrder: { seq: 44 },
      annulledAt: ANNULLED_AT,
      annulReason: 'mal ingreso',
    };

    it('lista los anulados manuales del cliente de pedidos anulados, con tope y sin FOR UPDATE', async () => {
      const { service, findManyDocs, queryRaw } = buildList([candidate]);
      const out = await service.candidates(ADMIN, TARGET);
      expect(out).toEqual([
        {
          id: 'doc-1389',
          number: 'FFA1-00001389',
          docType: FiscalDocType.FACTURA,
          issueDate: '2026-08-20',
          totalPen: '23.6000',
          sourceOrderId: SOURCE,
          sourceOrderCode: 'PED-000044',
          annulledAt: ANNULLED_AT.toISOString(),
          annulReason: 'mal ingreso',
          availability: { ok: true, reason: null },
        },
      ]);
      const where = (
        callArg(findManyDocs, 0, 0) as { where: Record<string, unknown>; take: number }
      ).where;
      expect(where).toMatchObject({
        customerId: 'cust-1',
        status: FiscalDocumentStatus.ANNULLED,
        origin: FiscalDocumentOrigin.MANUAL,
        archivedAt: null,
        salesOrderId: { not: TARGET },
        salesOrder: { status: 'CANCELLED' },
      });
      expect((callArg(findManyDocs, 0, 0) as { take: number }).take).toBe(MOVABLE_CANDIDATES_LIMIT);
      const sqls = (queryRaw.mock.calls as unknown[][]).map((c) =>
        (c[0] as TemplateStringsArray).join('?'),
      );
      expect(sqls.some((q) => q.includes('FOR UPDATE'))).toBe(false);
    });

    it('un pedido destino que no existe', async () => {
      const { service } = buildList([]);
      const prismaless = service as unknown as {
        prisma: { salesOrder: { findUnique: jest.Mock } };
      };
      prismaless.prisma.salesOrder.findUnique.mockResolvedValueOnce(null);
      await expect(service.candidates(ADMIN, TARGET)).rejects.toThrow(NotFoundException);
    });
  });
});
