import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { findLineReservation, resolveDispatchTarget } from '../sales/reservation-transfer';
import { InvoiceDispatchService, planSignature } from './invoice-dispatch.service';

jest.mock('../sales/reservation-transfer', () => ({
  resolveDispatchTarget: jest.fn(),
  findLineReservation: jest.fn(),
}));

/**
 * D-278 a nivel servicio: de las filas de la base al plan, y del plan a los despachos. La base
 * es una `tx` falsa con lo justo que el servicio lee; las decisiones línea por línea ya las
 * prueba `invoice-dispatch-plan.spec.ts`.
 */

const D = (v: string): Prisma.Decimal => new Prisma.Decimal(v);
const day = (v: string): Date => new Date(`${v}T00:00:00.000Z`);

const ADMIN = { id: 'admin', role: 'ADMINISTRADOR' } as RequestUser;

interface Fixture {
  invoices: {
    id: string;
    number: string;
    issueDate: string;
    items: { id: string; orderItemId: string; qty: string }[];
  }[];
  orderItems: {
    id: string;
    lineNumber: number;
    qty: string;
    reserveItemType: 'PRODUCT' | 'COIL';
    reserveItemId: string;
    reserveQty: string;
    sku: string;
  }[];
  dispatched?: { orderItemId: string; qty: string }[];
  credited?: { invoiceItemId: string; qty: string }[];
  movements: {
    itemType: 'PRODUCT' | 'COIL';
    itemId: string;
    type: 'IN' | 'OUT' | 'ADJUST';
    qty: string;
    refType: string;
    date: string;
  }[];
  balances: { itemType: 'PRODUCT' | 'COIL'; itemId: string; qty: string; avgCost: string }[];
}

function fakeTx(f: Fixture) {
  const invoiceItems = f.invoices.flatMap((inv) =>
    inv.items.map((it) => ({
      id: it.id,
      salesOrderItemId: it.orderItemId,
      qty: D(it.qty),
      document: { id: inv.id, issueDate: day(inv.issueDate), number: inv.number },
    })),
  );
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    fiscalDocument: {
      findUnique: jest.fn().mockResolvedValue({ id: 'F1', salesOrderId: 'ped' }),
      findMany: jest.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(
          f.invoices
            .filter((inv) => where.id === undefined || where.id === inv.id)
            .map((inv) => ({
              id: inv.id,
              number: inv.number,
              issueDate: day(inv.issueDate),
              salesOrderId: 'ped',
              salesOrder: { seq: 18, sellerId: null },
              items: inv.items.map((it) => ({ id: it.id, salesOrderItemId: it.orderItemId })),
            })),
        ),
      ),
    },
    fiscalDocumentItem: {
      findMany: jest.fn().mockResolvedValue(invoiceItems),
      groupBy: jest.fn().mockResolvedValue(
        (f.credited ?? []).map((c) => ({
          affectedItemId: c.invoiceItemId,
          _sum: { qty: D(c.qty) },
        })),
      ),
    },
    salesOrderItem: {
      findMany: jest.fn().mockResolvedValue(
        f.orderItems.map((i) => ({
          id: i.id,
          lineNumber: i.lineNumber,
          productId: `prod-${i.id}`,
          qty: D(i.qty),
          reserveItemType: i.reserveItemType,
          reserveItemId: i.reserveItemId,
          reserveQty: D(i.reserveQty),
          reserveUnit: i.reserveItemType === 'COIL' ? 'KGM' : 'NIU',
          product: { sku: i.sku, businessLine: { inventoryStrategy: 'WEIGHTED_AVERAGE' } },
        })),
      ),
    },
    dispatchItem: {
      groupBy: jest.fn().mockResolvedValue(
        (f.dispatched ?? []).map((d) => ({
          salesOrderItemId: d.orderItemId,
          _sum: { qty: D(d.qty) },
        })),
      ),
    },
    inventoryMovement: {
      findMany: jest.fn().mockResolvedValue(
        f.movements.map((m, i) => ({
          id: BigInt(i + 1),
          at: new Date(`${m.date}T12:00:00.000Z`),
          itemType: m.itemType,
          itemId: m.itemId,
          type: m.type,
          qty: D(m.qty),
          refType: m.refType,
          operationDate: day(m.date),
        })),
      ),
    },
    inventoryBalance: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          f.balances.map((b) => ({ ...b, qty: D(b.qty), avgCost: D(b.avgCost), unit: 'NIU' })),
        ),
    },
    product: { findMany: jest.fn().mockResolvedValue([{ id: 'upvc', sku: 'UPVC36MT' }]) },
    coil: { findMany: jest.fn().mockResolvedValue([{ id: 'bob', code: 'IMPO-1' }]) },
    productionReport: { findMany: jest.fn().mockResolvedValue([]) },
    salesOrder: { findUniqueOrThrow: jest.fn().mockResolvedValue({ status: 'FULFILLED' }) },
  };
  return tx;
}

function service(tx: ReturnType<typeof fakeTx>) {
  const dispatches = {
    pickupLocationInTx: jest.fn().mockResolvedValue({ address: 'Almacén', ubigeo: '150101' }),
    createInTx: jest
      .fn()
      .mockResolvedValueOnce('11111111-1111-4111-8111-111111111111')
      .mockResolvedValueOnce('22222222-2222-4222-8222-222222222222'),
    linkInvoiceInTx: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
  };
  const svc = new InvoiceDispatchService(
    prisma as never,
    dispatches as never,
    audit as never,
    { historicalLoadStart: '2026-08-01' } as never,
  );
  return { svc, dispatches, audit, prisma };
}

/** UPVC con carga inicial el 22/09, facturado el 11/08; una bobina comprada y facturada el 01/08. */
const MIXED: Fixture = {
  invoices: [
    {
      id: 'F1',
      number: 'FFA1-1',
      issueDate: '2026-08-11',
      items: [
        { id: 'fi-1', orderItemId: 'l1', qty: '50' },
        { id: 'fi-2', orderItemId: 'l2', qty: '1' },
      ],
    },
  ],
  orderItems: [
    {
      id: 'l1',
      lineNumber: 1,
      qty: '50',
      reserveItemType: 'PRODUCT',
      reserveItemId: 'upvc',
      reserveQty: '50',
      sku: 'UPVC36MT',
    },
    {
      id: 'l2',
      lineNumber: 2,
      qty: '1',
      reserveItemType: 'COIL',
      reserveItemId: 'bob',
      reserveQty: '3866',
      sku: 'BOB038ROJO',
    },
  ],
  movements: [
    {
      itemType: 'COIL',
      itemId: 'bob',
      type: 'IN',
      qty: '3866',
      refType: 'PURCHASE',
      date: '2026-08-01',
    },
    {
      itemType: 'PRODUCT',
      itemId: 'upvc',
      type: 'IN',
      qty: '970',
      refType: 'IMPORT',
      date: '2026-09-22',
    },
  ],
  balances: [
    { itemType: 'COIL', itemId: 'bob', qty: '3866', avgCost: '3.43' },
    { itemType: 'PRODUCT', itemId: 'upvc', qty: '970', avgCost: '43.22' },
  ],
};

beforeEach(() => {
  jest.mocked(resolveDispatchTarget).mockImplementation((_tx, item) =>
    Promise.resolve({
      itemType: item.reserveItemType,
      itemId: item.reserveItemId,
      unit: item.reserveUnit,
      reservationId: `res-${item.id}`,
      fromProduction: false,
    }),
  );
  jest.mocked(findLineReservation).mockResolvedValue(null);
});

describe('InvoiceDispatchService (D-278)', () => {
  it('planAll: excepción para lo anterior a la carga inicial, salida prorrateada para la bobina', async () => {
    const tx = fakeTx(MIXED);
    const { svc } = service(tx);
    const plan = await svc.planAll();
    expect(tx.$executeRaw).toHaveBeenCalled(); // READ ONLY
    expect(plan.invoices).toHaveLength(1);
    const [upvc, bob] = plan.invoices[0]!.lines;
    expect(upvc).toMatchObject({ action: 'BEFORE_OPENING', sku: 'UPVC36MT' });
    // La bobina entró el 01/08 y se facturó el 11/08: sale, con los kilos de la reserva (1 u → 3866 kg).
    expect(bob).toMatchObject({ action: 'DISPATCH', itemKey: 'COIL:bob' });
    expect(bob!.reserveQty.toFixed(3)).toBe('3866.000');
    expect(plan.items.get('COIL:bob')?.label).toBe('IMPO-1');
    expect(plan.invoices[0]!.orderCode).toBe('PED-000018');
  });

  it('lo acreditado por nota de crédito y lo ya despachado no se vuelven a despachar', async () => {
    const tx = fakeTx({
      ...MIXED,
      credited: [{ invoiceItemId: 'fi-1', qty: '20' }],
      dispatched: [{ orderItemId: 'l1', qty: '30' }],
    });
    const { svc } = service(tx);
    const plan = await svc.planAll();
    // 50 facturados − 20 acreditados = 30, y ya se despacharon 30: nada que hacer en la línea 1.
    expect(plan.invoices[0]!.lines.map((l) => l.sku)).toEqual(['BOB038ROJO']);
  });

  it('la línea que falta producir va a revisión con el motivo del despacho', async () => {
    jest
      .mocked(resolveDispatchTarget)
      .mockRejectedValue(new BadRequestException('produce lo que falta antes de despacharlo'));
    const { svc } = service(fakeTx(MIXED));
    const plan = await svc.planAll();
    expect(plan.invoices[0]!.lines.every((l) => l.action === 'REVIEW')).toBe(true);
    expect(plan.invoices[0]!.lines[0]!.reason).toContain('produce lo que falta');
  });

  it('lo fabricado y reservado se reparte entre los comprobantes de la línea', async () => {
    jest.mocked(resolveDispatchTarget).mockResolvedValue({
      itemType: 'PRODUCT',
      itemId: 'upvc',
      unit: 'MTR',
      reservationId: 'r',
      fromProduction: true,
    });
    jest.mocked(findLineReservation).mockResolvedValue({
      id: 'r',
      qty: new Decimal(6),
      status: 'ACTIVE',
      unit: 'MTR',
    });
    const tx = fakeTx({
      invoices: [
        {
          id: 'A',
          number: 'A-1',
          issueDate: '2026-09-23',
          items: [{ id: 'a', orderItemId: 'l1', qty: '5' }],
        },
        {
          id: 'B',
          number: 'B-1',
          issueDate: '2026-09-24',
          items: [{ id: 'b', orderItemId: 'l1', qty: '5' }],
        },
      ],
      orderItems: [MIXED.orderItems[0]!],
      movements: [
        {
          itemType: 'PRODUCT',
          itemId: 'upvc',
          type: 'IN',
          qty: '100',
          refType: 'PRODUCTION',
          date: '2026-09-20',
        },
      ],
      balances: [{ itemType: 'PRODUCT', itemId: 'upvc', qty: '100', avgCost: '1' }],
    });
    const plan = await service(tx).svc.planAll();
    expect(plan.invoices.map((i) => i.lines[0]!.action)).toEqual(['DISPATCH', 'REVIEW']);
  });

  it('el comprobante anterior al inicio de la carga histórica va a revisión', async () => {
    const f = { ...MIXED, invoices: [{ ...MIXED.invoices[0]!, issueDate: '2026-07-31' }] };
    const plan = await service(fakeTx(f)).svc.planAll();
    expect(plan.invoices[0]!.lines[0]!.reason).toContain('carga histórica');
  });

  it('executeForInvoice: lock del pedido, un despacho con salida y otro sin salida, enlazados y auditados', async () => {
    const f: Fixture = {
      ...MIXED,
      // La bobina entró el 01/08 y se facturó el 11/08: sale del almacén.
      movements: [
        {
          itemType: 'COIL',
          itemId: 'bob',
          type: 'IN',
          qty: '3866',
          refType: 'PURCHASE',
          date: '2026-08-01',
        },
        {
          itemType: 'PRODUCT',
          itemId: 'upvc',
          type: 'IN',
          qty: '970',
          refType: 'IMPORT',
          date: '2026-09-22',
        },
      ],
    };
    const tx = fakeTx(f);
    const { svc, dispatches, audit } = service(tx);
    const result = await svc.executeForInvoice(ADMIN, 'F1');

    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(dispatches.createInTx).toHaveBeenCalledTimes(2);
    const [, , withMovement, withMovementOpts] = dispatches.createInTx.mock.calls[0]!;
    expect(withMovement).toMatchObject({
      dispatchDate: '2026-08-11',
      transferMode: 'PICKUP',
      confirmBackdate: true,
      items: [{ salesOrderItemId: 'l2', qty: '1.000' }],
    });
    expect(withMovementOpts).toMatchObject({ auditReason: 'despacho a la fecha del comprobante' });
    const [, , , beforeOpts] = dispatches.createInTx.mock.calls[1]!;
    expect([
      ...(beforeOpts as { deliveredBeforeOpening: Set<string> }).deliveredBeforeOpening,
    ]).toEqual(['l1']);
    expect(dispatches.linkInvoiceInTx).toHaveBeenCalledTimes(2);
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'invoicing.dispatch-at-issue-date', entityId: 'F1' }),
    );
    expect(result.dispatchIds).toHaveLength(2);
    expect(result.orderStatus).toBe('FULFILLED');
  });

  it('executeInTx para si el plan cambió desde el dry-run, sin escribir', async () => {
    const tx = fakeTx(MIXED);
    const { svc, dispatches } = service(tx);
    const plan = await svc.planAll();
    const stale = { ...plan.invoices[0]!, lines: plan.invoices[0]!.lines.slice(0, 1) };
    await expect(svc.executeInTx(tx as never, ADMIN, 'F1', stale)).rejects.toThrow('cambió');
    expect(dispatches.createInTx).not.toHaveBeenCalled();
    expect(planSignature(plan.invoices[0]!)).toContain('BEFORE_OPENING');
  });

  it('sin nada que despachar, o todo a revisión, no escribe y lo dice', async () => {
    const empty = fakeTx({
      ...MIXED,
      dispatched: [
        { orderItemId: 'l1', qty: '50' },
        { orderItemId: 'l2', qty: '1' },
      ],
    });
    await expect(service(empty).svc.executeForInvoice(ADMIN, 'F1')).rejects.toThrow(
      'sin despachar',
    );

    jest.mocked(resolveDispatchTarget).mockRejectedValue(new BadRequestException('falta producir'));
    const review = service(fakeTx(MIXED));
    await expect(review.svc.executeForInvoice(ADMIN, 'F1')).rejects.toThrow('Ninguna línea');
    expect(review.dispatches.createInTx).not.toHaveBeenCalled();
  });

  it('preview devuelve las líneas con su acción y el ítem', async () => {
    const dto = await service(fakeTx(MIXED)).svc.preview(ADMIN, 'F1');
    expect(dto.lines[0]).toMatchObject({
      sku: 'UPVC36MT',
      action: 'BEFORE_OPENING',
      itemLabel: 'UPVC36MT',
    });
  });
});
