import { ConflictException, BadRequestException } from '@nestjs/common';
import { ExchangeRateSource, Prisma } from '@prisma/client';
import { Decimal, type CreatePurchaseInput } from '@ayr/shared';
import { PurchasesService } from './purchases.service';

/**
 * D-351 — `createInTx`: el alta de una compra dentro de una transacción ajena (el importador), con
 * todas las validaciones leyendo de `tx` (el proveedor puede haberse creado en esa misma
 * transacción), el lote del importador y el código externo de cada bobina.
 */

const ACTOR = { id: 'u-1', role: 'ADMINISTRADOR' } as never;
const EXCHANGE = { rate: new Decimal(1), source: ExchangeRateSource.MANUAL };

const COIL_INPUT: CreatePurchaseInput = {
  supplierId: 'sup-1',
  businessLine: 'metallic-roofing',
  type: 'COIL',
  docType: 'FACTURA',
  series: 'F001',
  number: '1',
  issueDate: '2026-09-20',
  currency: 'PEN',
  igvRate: '18.0000',
  paymentTerms: 'CONTADO',
  items: [
    {
      description: 'Bobina',
      qty: '1000.000',
      unit: 'KGM',
      unitPrice: '3.0000',
      finishId: 'fin-1',
      thicknessMm: '0.30',
      widthMm: '1220.00',
    },
  ],
};

function txWith(opts: { supplierActive?: boolean; createError?: unknown } = {}) {
  const create = opts.createError
    ? jest.fn().mockRejectedValue(opts.createError)
    : jest.fn().mockResolvedValue({
        id: 'pu-1',
        supplierId: 'sup-1',
        type: 'COIL',
        series: 'F001',
        number: '1',
        total: new Prisma.Decimal('3540'),
        currency: 'PEN',
      });
  return {
    supplier: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'sup-1', isActive: opts.supplierActive ?? true }),
    },
    businessLine: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'bl-1', code: 'METALLIC_ROOFING', inventoryStrategy: 'STOCK' }),
    },
    finish: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'fin-1',
          code: 'ALZ',
          kind: 'PREPINTADO',
          colorId: 'col-1',
          businessLineId: 'bl-1',
          color: { isActive: true, name: 'Rojo' },
        },
      ]),
    },
    purchase: { create },
  };
}

function service() {
  const svc = Object.create(PurchasesService.prototype) as PurchasesService;
  Object.assign(svc, { audit: { write: jest.fn().mockResolvedValue(undefined) } });
  return svc;
}

describe('PurchasesService.createInTx (D-351)', () => {
  it('lee el proveedor y el acabado de la transacción y guarda el lote y el código externo', async () => {
    const tx = txWith();
    await service().createInTx(tx as never, ACTOR, COIL_INPUT, EXCHANGE, {
      importBatchId: 'batch-1',
      externalCodes: ['PROV-77'],
    });
    expect(tx.supplier.findUnique).toHaveBeenCalled();
    const data = (tx.purchase.create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    // Nace en BORRADOR: el alta no fija estado (default DRAFT de la base).
    expect(data).toMatchObject({ importBatchId: 'batch-1' });
    expect(data.status).toBeUndefined();
    expect(data.items).toMatchObject({
      create: [{ externalCode: 'PROV-77', colorId: 'col-1', qty: '1000.000' }],
    });
  });

  it('sin opciones, una compra del formulario no lleva lote ni código externo', async () => {
    const tx = txWith();
    await service().createInTx(tx as never, ACTOR, COIL_INPUT, EXCHANGE);
    const data = (tx.purchase.create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(data.importBatchId).toBeNull();
    expect(data.items).toMatchObject({ create: [{ externalCode: null }] });
  });

  it('proveedor desactivado: 400 antes de escribir', async () => {
    const tx = txWith({ supplierActive: false });
    await expect(
      service().createInTx(tx as never, ACTOR, COIL_INPUT, EXCHANGE),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.purchase.create).not.toHaveBeenCalled();
  });

  it('D-132: el índice único parcial se traduce a 409', async () => {
    const tx = txWith({
      createError: new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    });
    await expect(
      service().createInTx(tx as never, ACTOR, COIL_INPUT, EXCHANGE),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('PurchasesService.resolveExchangeRate (D-351)', () => {
  it('el TC del input manda; en soles es 1', async () => {
    const svc = Object.create(PurchasesService.prototype) as PurchasesService;
    const manual = await svc.resolveExchangeRate({
      exchangeRate: '3.8',
      issueDate: '2026-09-20',
      currency: 'USD',
    });
    expect(manual).toEqual({ rate: new Decimal('3.8'), source: ExchangeRateSource.MANUAL });
    const pen = await svc.resolveExchangeRate({ issueDate: '2026-09-20', currency: 'PEN' });
    expect(pen.rate.toFixed(0)).toBe('1');
  });

  it('cc33 N1: en soles el TC es 1 aunque el input traiga otro', async () => {
    const svc = Object.create(PurchasesService.prototype) as PurchasesService;
    const pen = await svc.resolveExchangeRate({
      exchangeRate: '3.75',
      issueDate: '2026-09-20',
      currency: 'PEN',
    });
    expect(pen).toEqual({ rate: new Decimal(1), source: ExchangeRateSource.MANUAL });
  });
});

describe('PurchasesService.createInTx — compra en soles (cc33 N1)', () => {
  it('guarda TC 1 y totalPen igual al total aunque le llegue otro TC', async () => {
    const tx = txWith();
    await service().createInTx(tx as never, ACTOR, COIL_INPUT, {
      rate: new Decimal('3.75'),
      source: ExchangeRateSource.MANUAL,
    });
    const data = (tx.purchase.create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(data.exchangeRate).toBe('1.0000');
    // 1000 kg × 3 = 3000 + IGV 18 % = 3540: la recepción costea con este mismo TC.
    expect(data.total).toBe('3540.0000');
    expect(data.totalPen).toBe('3540.0000');
  });
});

describe('PurchasesService.addPayment — pago en soles de una compra en soles (cc33 N1)', () => {
  it('guarda TC 1 aunque el body traiga un TC viejo', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'pay-1',
      amount: new Prisma.Decimal('100'),
      currency: 'PEN',
      method: 'TRANSFER',
    });
    const purchase = {
      id: 'pu-1',
      status: 'RECEIVED',
      currency: 'PEN',
      total: new Prisma.Decimal('3540'),
      payments: [],
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      purchase: { findUniqueOrThrow: jest.fn().mockResolvedValue(purchase) },
      supplierPayment: { create },
    };
    const svc = Object.create(PurchasesService.prototype) as PurchasesService;
    Object.assign(svc, {
      operationDate: { resolve: () => '2026-09-27' },
      audit: { write: jest.fn().mockResolvedValue(undefined) },
      prisma: {
        purchase: { findUnique: jest.fn().mockResolvedValue(purchase) },
        $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      },
    });
    jest.spyOn(svc, 'findOne').mockResolvedValue({} as never);
    await svc.addPayment(ACTOR, 'pu-1', {
      date: '2026-09-27',
      amount: '100',
      currency: 'PEN',
      exchangeRate: '3.75',
      method: 'TRANSFER',
    } as never);
    expect(
      (create.mock.calls[0] as [{ data: { exchangeRate: string } }])[0].data.exchangeRate,
    ).toBe('1.0000');
  });
});

describe('PurchasesService.cancel — onlyDraft (D-351, deshacer lote)', () => {
  it('una compra que ya se recibió no se anula desde el lote', async () => {
    const svc = Object.create(PurchasesService.prototype) as PurchasesService;
    const transaction = jest.fn();
    Object.assign(svc, {
      operationDate: { resolve: () => '2026-09-27' },
      prisma: {
        purchase: {
          findUnique: jest.fn().mockResolvedValue({ id: 'pu-1', status: 'RECEIVED', payments: [] }),
        },
        $transaction: transaction,
      },
    });
    await expect(
      svc.cancel(ACTOR, 'pu-1', { reason: 'Deshacer lote' }, { onlyDraft: true }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('PurchasesService.cancel — saldos bloqueados antes del guardrail (D-382, P2-A)', () => {
  it('bloquea los ítems de la compra antes de buscar movimientos posteriores', async () => {
    const calls: string[] = [];
    const own = ['prod-b', 'prod-a', 'prod-b'].map((itemId, i) => ({
      id: BigInt(10 + i),
      businessLineId: 'bl-1',
      itemType: 'PRODUCT',
      itemId,
      type: 'IN',
      unit: 'NIU',
      qty: new Prisma.Decimal(1),
      totalCost: new Prisma.Decimal(1),
      reversalOfId: null,
      reversals: [],
    }));
    let movementQueries = 0;
    const tx = {
      purchase: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      supplierPayment: { count: jest.fn().mockResolvedValue(0) },
      inventoryMovement: {
        findMany: jest.fn().mockImplementation(() => {
          movementQueries++;
          calls.push(movementQueries === 1 ? 'own' : 'later');
          return Promise.resolve(movementQueries === 1 ? own : []);
        }),
      },
      coil: {
        // D-386 (P3-1 de cc15b): la toma inicial lee **todas** las bobinas con el `purchaseId`
        // (sin filtro de estado), incluidos los flejes heredados; las demás lecturas, vacías.
        findMany: jest
          .fn()
          .mockImplementation((args: { where: { status?: unknown } }) =>
            Promise.resolve(args.where.status === undefined ? [{ id: 'fleje-1' }] : []),
          ),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const svc = Object.create(PurchasesService.prototype) as PurchasesService;
    let lockedCoilIds: string[] = [];
    Object.assign(svc, {
      operationDate: { resolve: () => '2026-10-03' },
      audit: { write: jest.fn().mockResolvedValue(undefined) },
      inventory: {
        lockInOrder: jest
          .fn()
          .mockImplementation((_tx, set: { coilIds: string[]; items: { itemId: string }[] }) => {
            lockedCoilIds = set.coilIds;
            calls.push(`lock:${set.items.map((r) => r.itemId).join(',')}`);
            return Promise.resolve();
          }),
        reverse: jest.fn().mockImplementation(() => {
          calls.push('reverse');
          return Promise.resolve();
        }),
      },
      prisma: {
        purchase: {
          findUnique: jest.fn().mockResolvedValue({ id: 'pu-1', status: 'RECEIVED', payments: [] }),
        },
        $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      },
      findOne: jest.fn().mockResolvedValue({ id: 'pu-1' }),
    });

    await svc.cancel(ACTOR, 'pu-1', { reason: 'Anular' });
    expect(calls.slice(0, 3)).toEqual(['own', 'lock:prod-b,prod-a,prod-b', 'later']);
    expect(calls.filter((c) => c === 'reverse')).toHaveLength(3);
    expect(lockedCoilIds).toEqual(['fleje-1']);
  });
});

describe('PurchasesService.receive — saldos por clave antes del primer ingreso (D-386)', () => {
  it('una compra de producto toma todos sus saldos de una vez, antes de cualquier record', async () => {
    const stop = new Error('fin deliberado en la toma');
    const record = jest.fn();
    const lockInOrder = jest.fn().mockRejectedValue(stop);
    const tx = {
      purchase: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      purchaseItem: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'i1', productId: 'prod-b', unit: 'NIU' },
          { id: 'i2', productId: null, unit: 'NIU' },
          { id: 'i3', productId: 'prod-a', unit: 'NIU' },
        ]),
      },
    };
    const svc = Object.create(PurchasesService.prototype) as PurchasesService;
    Object.assign(svc, {
      operationDate: { resolve: () => '2026-10-04' },
      inventory: { lockInOrder, record },
      prisma: {
        purchase: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pu-1',
            status: 'DRAFT',
            type: 'FINISHED_GOOD',
            businessLineId: 'bl-1',
            items: [],
          }),
        },
        $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      },
    });

    await expect(svc.receive(ACTOR, 'pu-1')).rejects.toBe(stop);
    expect(record).not.toHaveBeenCalled();
    expect(lockInOrder).toHaveBeenCalledWith(tx, {
      items: [
        { businessLineId: 'bl-1', itemType: 'PRODUCT', itemId: 'prod-b', unit: 'NIU' },
        { businessLineId: 'bl-1', itemType: 'PRODUCT', itemId: 'prod-a', unit: 'NIU' },
      ],
    });
  });
});
