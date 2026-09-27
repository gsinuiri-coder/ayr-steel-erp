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
});
