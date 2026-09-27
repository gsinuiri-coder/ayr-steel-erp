import { BusinessLineCode, QuotationStatus, type Prisma } from '@prisma/client';
import {
  DEAD_QUOTATION_STATUSES,
  describeProductRealUsage,
  productsRealUsage,
  structureLockReason,
} from './product-real-usage';

/**
 * D-348 — «uso real»: lo que impide cambiar subtipo, espesor o color. Más laxo que el uso del
 * borrado (D-347) a propósito: una cotización anulada o vencida no cuenta.
 */

const PRODUCT = {
  id: 'p-1',
  sku: 'ACCES030ROJO',
  name: 'Accesorio',
  businessLine: { code: BusinessLineCode.METALLIC_ROOFING },
};

interface Where {
  quotation?: { status: { notIn: QuotationStatus[] } };
}

function fakeTx(opts: { quotations?: QuotationStatus[]; movements?: number; balances?: number }) {
  const liveOf = (where: Where) =>
    (opts.quotations ?? []).filter((s) => !(where.quotation?.status.notIn ?? []).includes(s));
  const empty = () => ({
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
  });
  return {
    inventoryMovement: {
      count: jest.fn().mockResolvedValue(opts.movements ?? 0),
      findMany: jest
        .fn()
        .mockResolvedValue((opts.movements ?? 0) > 0 ? [{ itemId: PRODUCT.id }] : []),
    },
    inventoryBalance: {
      count: jest.fn().mockResolvedValue(opts.balances ?? 0),
      findMany: jest
        .fn()
        .mockResolvedValue((opts.balances ?? 0) > 0 ? [{ itemId: PRODUCT.id }] : []),
    },
    purchaseItem: empty(),
    salesOrderItem: empty(),
    fiscalDocumentItem: empty(),
    dispatchItem: empty(),
    productionOrder: empty(),
    reservation: empty(),
    quotationReservation: empty(),
    quotationItem: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: { where: Where }) =>
          Promise.resolve(
            liveOf(where).map((_, i) => ({ productId: PRODUCT.id, quotation: { seq: i + 1 } })),
          ),
        ),
    },
  } as unknown as Prisma.TransactionClient;
}

describe('describeProductRealUsage (D-348)', () => {
  it('las anuladas y vencidas no cuentan: sin nada más, no hay uso real', async () => {
    const tx = fakeTx({ quotations: [QuotationStatus.CANCELLED, QuotationStatus.EXPIRED] });
    await expect(describeProductRealUsage(tx, PRODUCT)).resolves.toEqual([]);
    expect(DEAD_QUOTATION_STATUSES).toEqual([QuotationStatus.CANCELLED, QuotationStatus.EXPIRED]);
  });

  it.each([QuotationStatus.DRAFT, QuotationStatus.EMITTED, QuotationStatus.CONFIRMED])(
    'una cotización %s sí cuenta y se nombra',
    async (status) => {
      const reasons = await describeProductRealUsage(fakeTx({ quotations: [status] }), PRODUCT);
      expect(reasons).toEqual(['cotización(es) vigente(s) COT-000001']);
    },
  );

  it('el saldo sin movimientos (no debería existir) igual cuenta', async () => {
    await expect(describeProductRealUsage(fakeTx({ balances: 1 }), PRODUCT)).resolves.toEqual([
      'saldo de inventario',
    ]);
  });
});

describe('productsRealUsage (D-348)', () => {
  it('devuelve las categorías por producto, sin contar las cotizaciones muertas', async () => {
    const dead = await productsRealUsage(fakeTx({ quotations: [QuotationStatus.CANCELLED] }), [
      PRODUCT,
    ]);
    expect(dead.size).toBe(0);
    const used = await productsRealUsage(
      fakeTx({ quotations: [QuotationStatus.EMITTED], movements: 1, balances: 1 }),
      [PRODUCT],
    );
    expect(used.get(PRODUCT.id)).toEqual(['kardex', 'cotizaciones vigentes']);
  });

  it('una tanda vacía no consulta nada', async () => {
    const tx = fakeTx({});
    await expect(productsRealUsage(tx, [])).resolves.toEqual(new Map());
  });

  it('el motivo dice qué hacer', () => {
    expect(structureLockReason(['kardex'])).toMatch(
      /uso real \(kardex\).*Crea otro producto y desactiva este/,
    );
  });
});

describe('cotización vencida por fecha (D-348, segundo modelo)', () => {
  it('una EMITIDA con validUntil pasado no cuenta aunque el job no la haya marcado EXPIRED', async () => {
    const tx = fakeTx({});
    await describeProductRealUsage(tx, PRODUCT);
    const findMany = (tx as unknown as { quotationItem: { findMany: jest.Mock } }).quotationItem
      .findMany;
    const call = findMany.mock.calls[0] as [{ where: { quotation: Record<string, unknown> } }];
    expect(call[0].where.quotation).toMatchObject({
      NOT: { status: QuotationStatus.EMITTED, validUntil: { lt: expect.any(Date) } },
    });
  });
});
