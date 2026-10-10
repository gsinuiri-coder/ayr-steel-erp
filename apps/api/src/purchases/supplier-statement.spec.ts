import { Prisma } from '@prisma/client';
import { PurchasesService } from './purchases.service';

/**
 * cc39 (D-584) — el estado de cuenta del proveedor cuenta el atraso contra el día de **Lima**.
 * Antes lo cortaba en UTC y, entre las 19:00 y la medianoche de Lima, cada compra vencida salía
 * con un día de más. La aritmética vive en `overdueDays` (con sus horas de borde en
 * `purchase-math.spec.ts`); esto prueba que el estado de cuenta la usa con el reloj real.
 */

const D = (v: string) => new Prisma.Decimal(v);

function purchase(id: string, dueDate: string) {
  return {
    id,
    supplierId: 'sup-1',
    supplier: { name: 'Proveedor', code: 'PRV' },
    businessLine: { code: 'METALLIC_ROOFING' },
    type: 'COIL',
    docType: 'FACTURA',
    series: 'F001',
    number: id,
    issueDate: new Date('2026-09-09T00:00:00.000Z'),
    currency: 'PEN',
    exchangeRate: D('1'),
    exchangeRateSource: 'MANUAL',
    subtotal: D('100'),
    igv: D('18'),
    total: D('118'),
    totalPen: D('118'),
    paymentTerms: 'CREDITO',
    creditDays: 30,
    dueDate: new Date(`${dueDate}T00:00:00.000Z`),
    status: 'RECEIVED',
    serviceKind: null,
    relatedPurchaseId: null,
    relatedPurchase: null,
    relatedCuttingOrderId: null,
    relatedCuttingOrder: null,
    landedCostServices: [],
    sourceXmlKey: null,
    notes: null,
    payments: [],
    receivedAt: null,
    createdAt: new Date('2026-09-09T15:00:00.000Z'),
  };
}

function service(rows: ReturnType<typeof purchase>[]): PurchasesService {
  const prisma = {
    supplier: {
      findUnique: jest.fn().mockResolvedValue({ id: 'sup-1', name: 'Proveedor', code: 'PRV' }),
    },
    purchase: { findMany: jest.fn().mockResolvedValue(rows) },
  };
  const none = {} as never;
  return new PurchasesService(prisma as never, none, none, none, none, none, none);
}

describe('PurchasesService.supplierStatement — atraso en días de Lima (cc39, D-584)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ['18:59', '2026-10-09T23:59:00.000Z', 0],
    ['19:00', '2026-10-10T00:00:00.000Z', 0],
    ['23:59', '2026-10-10T04:59:00.000Z', 0],
    ['00:00 del día siguiente', '2026-10-10T05:00:00.000Z', 1],
  ])('vence el 9/10, son las %s de Lima: %#', async (_hour, utc, expected) => {
    jest.useFakeTimers({ now: new Date(utc), doNotFake: ['nextTick', 'setImmediate'] });
    const statement = await service([purchase('1', '2026-10-09')]).supplierStatement('sup-1');
    expect(statement.purchases).toHaveLength(1);
    expect(statement.purchases[0]?.overdueDays).toBe(expected);
  });
});
