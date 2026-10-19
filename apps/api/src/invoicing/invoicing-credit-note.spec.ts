import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  addDays,
  businessToday,
  createCreditNoteSchema,
  registerCreditNoteSchema,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { assertStockCreditNoteRole, InvoicingService } from './invoicing.service';

/**
 * cc54 (D-654..D-663) — la NC por motivo en el servicio, sin base: un doble de la transacción con el
 * comprobante afectado (una factura manual de 5 u a S/ 50 + IGV, S/ 295) y lo que cada motivo
 * escribe. Los recorridos contra la base viven en `credit-note-reasons.db-spec.ts`.
 */

const D = (v: string | number) => new Prisma.Decimal(v);
const TODAY = businessToday();
const ADMIN = { id: 'u-admin', role: 'ADMINISTRADOR' } as RequestUser;
const SELLER = { id: 'u-seller', role: 'VENDEDOR' } as RequestUser;

interface Options {
  docType?: 'FACTURA' | 'BOLETA';
  origin?: 'MANUAL' | 'ISSUED_HERE';
  paymentTerms?: 'CONTADO' | 'CREDITO';
  payments?: { amountPen: Prisma.Decimal }[];
  priorReplacement?: boolean;
  /** Líneas de NC anteriores sobre la línea 1 (las de otras notas, vivas). */
  others?: { qty: string; totalPen: string; reason: string }[];
}

function build(o: Options = {}) {
  const affected = {
    id: 'f-1',
    number: 'F001-00000001',
    docType: o.docType ?? 'FACTURA',
    origin: o.origin ?? 'MANUAL',
    status: 'ACCEPTED',
    customerId: 'c-1',
    salesOrderId: 'so-1',
    createdById: ADMIN.id,
    issueDate: new Date(`${addDays(TODAY, -5)}T00:00:00.000Z`),
    paymentTerms: o.paymentTerms ?? 'CONTADO',
    dueDate: o.paymentTerms === 'CREDITO' ? new Date(`${addDays(TODAY, 25)}T00:00:00.000Z`) : null,
    subtotalPen: D('250'),
    igvPen: D('45'),
    totalPen: D('295'),
    detractionCode: null,
    detractionPct: null,
    detractionAmountPen: null,
    affectedDocumentId: null,
    customer: { id: 'c-1', name: 'Cliente equivocado', docType: 'RUC', isActive: true },
    salesOrder: { sellerId: ADMIN.id, status: 'CONFIRMED', seq: 7 },
    dispatch: null,
    payments: o.payments ?? [],
    creditNotes: [],
    items: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        lineNumber: 1,
        qty: D('5'),
        subtotalPen: D('250'),
        igvPen: D('45'),
        totalPen: D('295'),
        unitPricePen: D('50'),
        description: 'Producto de muestra',
        productId: 'p-1',
        unit: 'NIU',
        salesOrderItemId: 'soi-1',
      },
    ],
  };
  const created: Record<string, unknown>[] = [];
  const notes = new Map<string, Record<string, unknown>>();
  const tx = {
    $queryRaw: jest.fn((_s: TemplateStringsArray, ids: string[]) =>
      Promise.resolve(ids.map((id) => ({ id }))),
    ),
    fiscalDocument: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === 'f-1' ? affected : (notes.get(where.id) ?? null)),
      ),
      findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === 'f-1' ? affected : notes.get(where.id)),
      ),
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          'replacesDocumentId' in where && o.priorReplacement ? { number: 'F001-00000002' } : null,
        ),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const id = data.docType === 'NOTA_CREDITO' ? 'nc-1' : 'rep-1';
        created.push({ id, ...data });
        const items = (data.items as { create: Record<string, unknown>[] }).create;
        notes.set(id, {
          ...data,
          id,
          status: 'DRAFT',
          origin: 'ISSUED_HERE',
          affectedDocument: {
            id: 'f-1',
            origin: affected.origin,
            number: affected.number,
            status: 'ACCEPTED',
            archivedAt: null,
          },
          items: items.map((i, n) => ({
            id: `${id}-it-${String(n)}`,
            qty: D(String(i.qty)),
            totalPen: D(String(i.totalPen)),
            salesOrderItemId: i.salesOrderItemId,
            affectedItemId: i.affectedItemId ?? null,
          })),
        });
        return Promise.resolve({ id });
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    fiscalDocumentItem: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        if ('id' in where)
          return Promise.resolve([
            {
              id: '00000000-0000-4000-8000-000000000001',
              lineNumber: 1,
              qty: D('5'),
              totalPen: D('295'),
            },
          ]);
        return Promise.resolve(
          (o.others ?? []).map((x) => ({
            affectedItemId: '00000000-0000-4000-8000-000000000001',
            qty: D(x.qty),
            subtotalPen: D(x.totalPen).div('1.18'),
            igvPen: D(x.totalPen).minus(D(x.totalPen).div('1.18')),
            totalPen: D(x.totalPen),
            document: { status: 'ACCEPTED', creditNoteReason: x.reason },
          })),
        );
      }),
    },
    customer: {
      findUnique: jest.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000002',
        name: 'Cliente correcto',
        docType: 'RUC',
        isActive: true,
        isSystem: false,
      }),
    },
    customerPayment: { findMany: jest.fn().mockResolvedValue(o.payments ?? []) },
    salesOrder: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ sellerId: ADMIN.id, status: 'CONFIRMED', seq: 7, customerId: 'c-1' }),
      update: jest.fn().mockResolvedValue({ seq: 7 }),
    },
    salesOrderItem: { findMany: jest.fn().mockResolvedValue([]) },
    dispatch: { findMany: jest.fn().mockResolvedValue([{ id: 'd-1' }]) },
  };
  const audit = { write: jest.fn() };
  const inventory = { moveInvoiceDispatches: jest.fn().mockResolvedValue(1) };
  const salesReturns = {
    planForLines: jest.fn().mockResolvedValue([
      [
        {
          qty: D('3'),
          reserveQty: D('3'),
          totalCost: D('60'),
          stock: {
            itemType: 'PRODUCT',
            itemId: 'p-1',
            unit: 'NIU',
            dispatchCode: 'DES-000001',
          },
        },
      ],
    ]),
    dispatchIdsForCreditNote: jest.fn().mockResolvedValue(['d-1']),
    createForCreditNoteInTx: jest.fn().mockResolvedValue('sr-1'),
  };
  tx.fiscalDocument.findMany.mockImplementation(() => Promise.resolve([]));
  const product = { findMany: jest.fn().mockResolvedValue([{ id: 'p-1', sku: 'SKU-MUESTRA' }]) };
  const coil = { findMany: jest.fn().mockResolvedValue([]) };
  const service = Object.create(InvoicingService.prototype) as InvoicingService;
  Object.assign(service, {
    prisma: { $transaction: (cb: (t: unknown) => unknown) => cb({ ...tx, product, coil }) },
    audit,
    inventory,
    salesReturns,
    operationDate: { assertIssueDate: jest.fn() },
    findOne: jest.fn((id: string) => Promise.resolve({ id })),
  });
  return { service, tx, audit, inventory, salesReturns, created };
}

const register = (body: Record<string, unknown>) =>
  registerCreditNoteSchema.parse({ issueDate: TODAY, series: 'FC01', correlative: 45, ...body });
const draft = (body: Record<string, unknown>) =>
  createCreditNoteSchema.parse({ issueDate: TODAY, ...body });
const noteData = (created: Record<string, unknown>[]) =>
  created.find((c) => c.docType === 'NOTA_CREDITO') as Record<string, unknown> & {
    items: { create: Record<string, unknown>[] };
  };

describe('InvoicingService.registerCreditNote — el motivo decide (cc54)', () => {
  it('05: rebaja el precio y registra en un paso, con su constancia', async () => {
    const { service, created, audit, tx } = build();
    await service.registerCreditNote(
      ADMIN,
      'f-1',
      register({
        reason: 'DESCUENTO_ITEM',
        prices: [
          { affectedItemId: '00000000-0000-4000-8000-000000000001', unitPriceWithIgvPen: '49' },
        ],
      }),
    );
    expect(noteData(created)).toMatchObject({
      creditNoteReason: 'DESCUENTO_ITEM',
      totalPen: '50.0000',
    });
    expect(tx.fiscalDocument.update).toHaveBeenCalled(); // applyManualNumber
    expect(
      (audit.write.mock.calls as unknown[][]).map((c) => (c[1] as { action: string }).action),
    ).toContain('invoicing.credit-note.create');
  });

  it('03: importe cero, con la descripción corregida', async () => {
    const { service, created } = build();
    await service.registerCreditNote(
      ADMIN,
      'f-1',
      register({
        reason: 'CORRECCION_DESCRIPCION',
        descriptions: [
          {
            affectedItemId: '00000000-0000-4000-8000-000000000001',
            description: 'Otra descripción',
          },
        ],
      }),
    );
    const note = noteData(created);
    expect(note.totalPen).toBe('0.0000');
    expect(note.items.create[0]).toMatchObject({
      description: 'Otra descripción',
      totalPen: '0.0000',
    });
  });

  it('04: el monto exacto; menos de un céntimo de rebaja no es una nota', async () => {
    const { service, created } = build();
    await service.registerCreditNote(
      ADMIN,
      'f-1',
      register({ reason: 'DESCUENTO_GLOBAL', amountPen: '59.00' }),
    );
    expect(noteData(created).totalPen).toBe('59.0000');
    const tiny = build();
    await expect(
      tiny.service.registerCreditNote(
        ADMIN,
        'f-1',
        register({
          reason: 'DESCUENTO_ITEM',
          prices: [
            {
              affectedItemId: '00000000-0000-4000-8000-000000000001',
              unitPriceWithIgvPen: '58.9999',
            },
          ],
        }),
      ),
    ).rejects.toThrow('no llega a un céntimo');
  });

  it('13: el vencimiento nuevo en la nota; solo en factura al crédito y distinto del vigente', async () => {
    const credit = build({ paymentTerms: 'CREDITO' });
    const due = addDays(TODAY, 40);
    await credit.service.registerCreditNote(
      ADMIN,
      'f-1',
      register({ reason: 'OTROS_AJUSTES', dueDate: due }),
    );
    expect(noteData(credit.created)).toMatchObject({ totalPen: '0.0000' });
    expect((noteData(credit.created).dueDate as Date).toISOString().slice(0, 10)).toBe(due);
    await expect(
      build({ paymentTerms: 'CREDITO' }).service.registerCreditNote(
        ADMIN,
        'f-1',
        register({ reason: 'OTROS_AJUSTES', dueDate: addDays(TODAY, 25) }),
      ),
    ).rejects.toThrow('ya vence');
    await expect(
      build({ paymentTerms: 'CREDITO' }).service.registerCreditNote(
        ADMIN,
        'f-1',
        register({ reason: 'OTROS_AJUSTES', dueDate: addDays(TODAY, -30) }),
      ),
    ).rejects.toThrow('anterior a la emisión');
    await expect(
      build().service.registerCreditNote(
        ADMIN,
        'f-1',
        register({ reason: 'OTROS_AJUSTES', dueDate: due }),
      ),
    ).rejects.toThrow('factura al crédito');
  });

  it('07: devuelve con su DEV- al registrar', async () => {
    const { service, salesReturns } = build();
    await service.registerCreditNote(
      ADMIN,
      'f-1',
      register({
        reason: 'DEVOLUCION_ITEM',
        items: [{ affectedItemId: '00000000-0000-4000-8000-000000000001', qty: '2' }],
      }),
    );
    expect(salesReturns.createForCreditNoteInTx).toHaveBeenCalledWith(
      expect.anything(),
      ADMIN,
      'nc-1',
      ['d-1'],
    );
  });

  it('02: crea el reemplazo, pasa el despacho y cambia el cliente del pedido', async () => {
    const { service, created, tx, inventory, audit } = build();
    await service.registerCreditNote(
      ADMIN,
      'f-1',
      register({
        reason: 'ANULACION_ERROR_RUC',
        replacement: {
          customerId: '00000000-0000-4000-8000-000000000002',
          issueDate: TODAY,
          series: 'F002',
          correlative: 9,
        },
      }),
    );
    const replacement = created.find((c) => c.docType === 'FACTURA');
    expect(replacement).toMatchObject({
      customerId: '00000000-0000-4000-8000-000000000002',
      status: 'ACCEPTED',
      origin: 'MANUAL',
      replacesDocumentId: 'f-1',
      number: 'F002-00000009',
    });
    expect(inventory.moveInvoiceDispatches).toHaveBeenCalledWith(expect.anything(), 'f-1', 'rep-1');
    expect(tx.salesOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { customerId: '00000000-0000-4000-8000-000000000002' } }),
    );
    const actions = (audit.write.mock.calls as unknown[][]).map(
      (c) => (c[1] as { action: string }).action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['invoicing.credit-note.replacement', 'sales.order.customer']),
    );
  });

  it('02: lo registra un administrador; con cobros o con un reemplazo anterior no', async () => {
    const body = register({
      reason: 'ANULACION_ERROR_RUC',
      replacement: {
        customerId: '00000000-0000-4000-8000-000000000002',
        issueDate: TODAY,
        series: 'F002',
        correlative: 9,
      },
    });
    await expect(build().service.registerCreditNote(SELLER, 'f-1', body)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      build({ payments: [{ amountPen: D('10') }] }).service.registerCreditNote(ADMIN, 'f-1', body),
    ).rejects.toThrow('tiene cobros registrados');
    await expect(
      build({ priorReplacement: true }).service.registerCreditNote(ADMIN, 'f-1', body),
    ).rejects.toThrow('ya tuvo un comprobante de reemplazo');
  });

  it('cc58 (D-678, C-04): 01, 06 y 07 devuelven mercadería: solo un administrador', async () => {
    for (const reason of ['ANULACION_OPERACION', 'DEVOLUCION_TOTAL', 'DEVOLUCION_ITEM'] as const) {
      await expect(
        // El rol se mira antes que el cuerpo: alcanza el motivo (sin líneas, que el esquema pediría).
        build().service.registerCreditNote(SELLER, 'f-1', {
          reason,
          issueDate: TODAY,
          series: 'FC01',
          correlative: 45,
        }),
      ).rejects.toThrow('la registra un administrador');
      await expect(
        build().service.createCreditNote(SELLER, 'f-1', { reason, issueDate: TODAY }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(() => {
      assertStockCreditNoteRole(SELLER, 'DESCUENTO_ITEM');
    }).not.toThrow();
    expect(() => {
      assertStockCreditNoteRole(ADMIN, 'DEVOLUCION_ITEM');
    }).not.toThrow();
  });

  it('un comprobante que no es manual no se registra a mano; el 02 no va por borrador', async () => {
    await expect(
      build({ origin: 'ISSUED_HERE' }).service.registerCreditNote(
        ADMIN,
        'f-1',
        register({ reason: 'ANULACION_OPERACION' }),
      ),
    ).rejects.toThrow('se emite, no se registra a mano');
    await expect(
      build().service.createCreditNote(
        ADMIN,
        'f-1',
        draft({
          reason: 'ANULACION_ERROR_RUC',
          replacement: {
            customerId: '00000000-0000-4000-8000-000000000002',
            issueDate: TODAY,
            series: 'F002',
            correlative: 9,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('una rebaja que pasa lo que queda de la línea se corta al revalidar', async () => {
    const { service } = build({
      others: [{ qty: '5', totalPen: '250', reason: 'DESCUENTO_ITEM' }],
    });
    await expect(
      service.registerCreditNote(
        ADMIN,
        'f-1',
        register({ reason: 'DESCUENTO_GLOBAL', amountPen: '100.00' }),
      ),
    ).rejects.toThrow('pasa lo que queda');
    const late = build({ others: [{ qty: '0.001', totalPen: '290', reason: 'DESCUENTO_ITEM' }] });
    await expect(
      late.service.registerCreditNote(
        ADMIN,
        'f-1',
        register({ reason: 'DESCUENTO_GLOBAL', amountPen: '5.00' }),
      ),
    ).resolves.toBeDefined();
  });
});

describe('InvoicingService.previewCreditNote — «Qué va a pasar» (cc54)', () => {
  it('01 sobre un manual: lo que vuelve, lo que no salió y el saldo', async () => {
    const { service } = build();
    const preview = await service.previewCreditNote(
      ADMIN,
      'f-1',
      draft({ reason: 'ANULACION_OPERACION' }),
    );
    expect(preview).toMatchObject({
      sunatCode: '01',
      totalPen: '295.0000',
      costPen: '60.0000',
      notDispatched: [{ lineNumber: 1, qty: '2.000' }],
      receivable: { beforePen: '295.0000', afterPen: '0.0000' },
    });
    expect(preview.stock).toEqual([
      {
        label: 'SKU-MUESTRA',
        qty: '3.000',
        unit: 'NIU',
        costPen: '60.0000',
        dispatch: 'DES-000001',
      },
    ]);
    expect(preview.warnings.some((w) => w.includes('no salió del almacén'))).toBe(true);
  });

  it('sobre un electrónico no promete devolución; una rebaja sobre boleta avisa la observación', async () => {
    const electronic = build({ origin: 'ISSUED_HERE' });
    const p = await electronic.service.previewCreditNote(
      ADMIN,
      'f-1',
      draft({ reason: 'ANULACION_OPERACION' }),
    );
    expect(p.stock).toEqual([]);
    expect(electronic.salesReturns.planForLines).not.toHaveBeenCalled();
    const boleta = build({ docType: 'BOLETA' });
    const q = await boleta.service.previewCreditNote(
      ADMIN,
      'f-1',
      draft({ reason: 'DESCUENTO_GLOBAL', amountPen: '10.00' }),
    );
    expect(q.warnings.some((w) => w.includes('4367'))).toBe(true);
    expect(q.receivable.afterPen).toBe('285.0000');
  });

  it('13: el saldo es el mismo con el vencimiento nuevo', async () => {
    const { service } = build({ paymentTerms: 'CREDITO' });
    const due = addDays(TODAY, 40);
    const p = await service.previewCreditNote(
      ADMIN,
      'f-1',
      draft({ reason: 'OTROS_AJUSTES', dueDate: due }),
    );
    expect(p.receivable).toMatchObject({
      beforePen: '295.0000',
      afterPen: '295.0000',
      dueDateAfter: due,
      dueDateBefore: addDays(TODAY, 25),
    });
  });
});
