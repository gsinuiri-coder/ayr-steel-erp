import { revertEntryErrors } from './initial-inventory-product-revert';

const clean = {
  sku: 'ESQ30',
  alreadyReversed: false,
  laterMovements: 0,
  activeReservations: 0,
  activeQuotationReservations: 0,
};

describe('revertEntryErrors (cc68, D-722)', () => {
  it('una carga que nadie usó se puede revertir', () => {
    expect(revertEntryErrors(clean)).toEqual([]);
  });

  it.each([
    [{ alreadyReversed: true }, /ESQ30: esta entrada ya se revirtió/],
    [{ laterMovements: 2 }, /ESQ30: tiene 2 movimiento\(s\) de kardex además de la carga/],
    [{ activeReservations: 1 }, /ESQ30: tiene 1 reserva\(s\) de pedido activa/],
    [{ activeQuotationReservations: 3 }, /ESQ30: tiene 3 reserva\(s\) temporal/],
  ])('rechaza y nombra el SKU: %o', (facts, message) => {
    const errors = revertEntryErrors({ ...clean, ...facts });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(message);
  });

  it('junta todos los motivos', () => {
    expect(
      revertEntryErrors({
        ...clean,
        laterMovements: 1,
        activeReservations: 1,
        activeQuotationReservations: 1,
      }),
    ).toHaveLength(3);
  });
});
