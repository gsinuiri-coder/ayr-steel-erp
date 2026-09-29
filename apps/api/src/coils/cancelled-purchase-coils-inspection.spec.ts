import { classifyCancelledPurchaseCoil } from './cancelled-purchase-coils-inspection';

const coil = {
  id: 'coil-1',
  sku: 'COB-001',
  purchaseId: 'purchase-1',
  purchaseDocument: 'F001-1',
  purchaseDate: '2026-08-01',
  kg: '100.000',
  entryDate: null,
  entryCostPerKg: null,
};
const original = {
  id: 10n,
  itemId: coil.id,
  type: 'IN' as const,
  refType: 'PURCHASE' as const,
  refId: coil.purchaseId,
  qty: { toString: () => '100.000' },
  unitCost: { toString: () => '4.0000' },
  operationDate: new Date('2026-08-01T05:00:00.000Z'),
  reversalOfId: null,
};

describe('classifyCancelledPurchaseCoil', () => {
  it('incluye una compra anulada que solo conserva su reversa propia', () => {
    const result = classifyCancelledPurchaseCoil(coil, [
      original,
      { ...original, id: 11n, type: 'OUT', reversalOfId: original.id },
    ]);

    expect(result).toMatchObject({
      verdict: 'RESTAURABLE-SEGURO',
      entryDate: '2026-08-01',
      entryCostPerKg: '4.0000',
      laterMovements: [],
    });
  });

  it('excluye una bobina con una salida posterior porque reinsertarla podría recostearla', () => {
    const result = classifyCancelledPurchaseCoil(coil, [
      original,
      { ...original, id: 11n, type: 'OUT', reversalOfId: original.id },
      {
        ...original,
        id: 12n,
        type: 'OUT',
        refType: 'PRODUCTION',
        refId: 'op-1',
        reversalOfId: null,
        operationDate: new Date('2026-08-02T05:00:00.000Z'),
      },
    ]);

    expect(result.verdict).toBe('EXCLUIDA');
    expect(result.reasons[0]).toContain('puede recostear');
    expect(result.laterMovements).toEqual([
      { id: '12', type: 'OUT', refType: 'PRODUCTION', operationDate: '2026-08-02' },
    ]);
  });
});
