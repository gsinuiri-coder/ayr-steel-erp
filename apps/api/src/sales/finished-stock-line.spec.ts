import {
  InventoryItemType,
  InventoryStrategy,
  RoofingProductKind,
  type Prisma,
} from '@prisma/client';
import { Decimal, Unit } from '@ayr/shared';
import { resolveSalesLines } from './sales-lines';

/**
 * **cc65 (D-697): la línea de mostrador de una cobertura terminada sale de su saldo.** Con
 * `fromFinishedStock` (solo lo pasa el mostrador) reserva el propio producto, en su unidad, sin
 * desglose de largos ni agregado de bobina. Sin la opción, la misma línea sigue fabricándose
 * contra el pedido (D-134/D-171). Un producto en metros que no es cobertura no cambia (D-098).
 */

const dec = (v: string): Prisma.Decimal => new Decimal(v);

function product(kind: RoofingProductKind | null, unit: string = Unit.MTR) {
  return {
    id: 'p-1',
    sku: 'COB040GRIS',
    name: 'Cobertura 0.40 gris',
    unit,
    isActive: true,
    businessLineId: 'bl-roofing',
    listPricePen: null,
    source: 'MANUFACTURED',
    pieceWeightKg: null,
    roofingKind: kind,
    lengthMm: kind === RoofingProductKind.PLANCHA ? dec('3000.00') : null,
    thicknessMm: dec('0.40'),
    widthMm: dec('1000.00'),
    colorId: 'color-gris',
    color: { name: 'Gris' },
    finish: { densityFactor: dec('8.0000') },
    businessLine: { inventoryStrategy: InventoryStrategy.STOCK, code: 'METALLIC_ROOFING' },
  };
}

function txWith(p: ReturnType<typeof product>) {
  const findFirst = jest.fn().mockResolvedValue({
    id: 'spec-1',
    businessLineId: 'bl-roofing',
    colorId: 'color-gris',
    thicknessMm: dec('0.40'),
  });
  const tx = {
    product: { findMany: jest.fn().mockResolvedValue([p]) },
    rawMaterialSpec: { findFirst },
  } as unknown as Prisma.TransactionClient;
  return { tx, findFirst };
}

describe('cc65 (D-697): cobertura terminada servida de su saldo', () => {
  it.each([
    [RoofingProductKind.ACCESORIO, Unit.MTR, '1.000'],
    [RoofingProductKind.A_MEDIDA, Unit.MTR, '2.500'],
    [RoofingProductKind.PLANCHA, Unit.NIU, '3.000'],
  ])('%s: reserva su propio producto, sin largos ni bobina', async (kind, unit, qty) => {
    const { tx, findFirst } = txWith(product(kind, unit));
    const [line] = await resolveSalesLines(tx, [{ productId: 'p-1', qty, unitPricePen: '20' }], {
      fromFinishedStock: true,
    });
    expect(line?.reserveItemType).toBe(InventoryItemType.PRODUCT);
    expect(line?.reserveItemId).toBe('p-1');
    expect(line?.reserveUnit).toBe(unit);
    expect(line?.reserveQty).toBe(qty);
    expect(line?.pieces).toEqual([]);
    // No se resuelve el agregado de bobina: la línea no se fabrica.
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('sin la opción, la cobertura a medida sigue pidiendo sus largos (se fabrica)', async () => {
    const { tx } = txWith(product(RoofingProductKind.A_MEDIDA));
    await expect(
      resolveSalesLines(tx, [{ productId: 'p-1', qty: '2.500', unitPricePen: '20' }]),
    ).rejects.toThrow('detalla cuántas planchas de cada largo');
  });

  it('sin la opción, el accesorio reserva kilos de bobina', async () => {
    const { tx } = txWith(product(RoofingProductKind.ACCESORIO));
    const [line] = await resolveSalesLines(tx, [
      { productId: 'p-1', qty: '1.000', unitPricePen: '20' },
    ]);
    expect(line?.reserveItemType).toBe(InventoryItemType.RAW_MATERIAL);
  });

  it('un producto en metros que no es cobertura sigue exigiendo su desglose (D-098)', async () => {
    const { tx } = txWith(product(null));
    await expect(
      resolveSalesLines(tx, [{ productId: 'p-1', qty: '2.500', unitPricePen: '20' }], {
        fromFinishedStock: true,
      }),
    ).rejects.toThrow('detalla cuántas planchas de cada largo');
  });
});
