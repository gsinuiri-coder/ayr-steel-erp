import { InventoryStrategy, type Prisma } from '@prisma/client';
import { toDecimal } from '@ayr/shared';
import { resolveSalesLines } from './sales-lines';

jest.mock('../production/production-assignments', () => ({
  findLiveStripAssignments: jest.fn().mockResolvedValue([]),
}));
jest.mock('./reserved-ledger', () => ({
  reservedByItem: jest.fn().mockResolvedValue(new Map()),
}));

/**
 * **Autorrevisión RF-S4b — las guardas que R1/R2 necesitaban y no tenían.**
 *
 * 1. El trío del papel (importe, IGV, total) solo entra si cuadra: sin esto, cualquier cliente
 *    del API guardaba una línea gravada con IGV cero o negativo (P0).
 * 2. Una bobina se vende en una sola línea del documento: con la cantidad del papel, dos líneas
 *    de la misma bobina prometían más kilos de los que el rollo tiene (P1).
 */

function txWith(): Prisma.TransactionClient {
  return {
    product: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'p-1',
          sku: 'COB040BLANCO',
          name: 'Cobertura',
          unit: 'KGM',
          isActive: true,
          businessLineId: 'bl-1',
          listPricePen: null,
          roofingKind: null,
          lengthMm: null,
          thicknessMm: null,
          widthMm: null,
          colorId: null,
          color: null,
          finish: null,
          businessLine: { inventoryStrategy: InventoryStrategy.STOCK, code: 'ROOFING' },
        },
      ]),
    },
    coil: { findMany: jest.fn().mockResolvedValue([]) },
    inventoryBalance: { findMany: jest.fn().mockResolvedValue([]) },
    businessLine: { findUnique: jest.fn().mockResolvedValue({ id: 'bl-trading' }) },
  } as unknown as Prisma.TransactionClient;
}

describe('RF-S4b — guardas de importes y de bobina', () => {
  it('el trío del papel que cuadra se guarda tal cual', async () => {
    const [line] = await resolveSalesLines(txWith(), [
      {
        productId: 'p-1',
        qty: '4194.000',
        netAmountPen: '12439.8310',
        igvAmountPen: '2239.1690',
        totalAmountPen: '14679.0000',
      },
    ]);
    expect(line?.igvPen).toBe('2239.1690');
    expect(toDecimal(line?.totalPen ?? '0').toFixed(2)).toBe('14679.00');
  });

  it.each([
    ['IGV cero sobre una línea gravada', '0.0000', '100.0000'],
    ['IGV negativo', '-10.0000', '90.0000'],
    ['el total no es importe + IGV', '18.0000', '120.0000'],
  ])('rechaza el trío cuando %s', async (_caso, igv, total) => {
    await expect(
      resolveSalesLines(txWith(), [
        {
          productId: 'p-1',
          qty: '10.000',
          netAmountPen: '100.0000',
          igvAmountPen: igv,
          totalAmountPen: total,
        },
      ]),
    ).rejects.toThrow(/no cuadran/);
  });

  it('una bobina no se vende en dos líneas del mismo documento', async () => {
    const coilId = '11111111-1111-4111-8111-111111111111';
    await expect(
      resolveSalesLines(txWith(), [
        { saleCoilId: coilId, qty: '100.000', unitPricePen: '3.0000' },
        { saleCoilId: coilId, qty: '100.000', unitPricePen: '3.0000' },
      ]),
    ).rejects.toThrow(/ya la vende otra línea/);
  });
});
