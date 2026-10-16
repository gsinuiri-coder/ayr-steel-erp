import {
  commitReceivedPurchaseEditSchema,
  costChangeNote,
  COST_CHANGE_REQUIRED_MESSAGE,
  updateCoilSchema,
} from '@ayr/shared';

/** cc56 (D-669): el costo de una entrada solo cambia con un motivo de la lista. */
describe('motivo de cambio de costo (D-669)', () => {
  it('editar el costo de una bobina sin motivo de la lista se rechaza con el mensaje claro', () => {
    const r = updateCoilSchema.safeParse({ unitCostPerKg: '2.5', reason: 'vender a menos costo' });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toContain(COST_CHANGE_REQUIRED_MESSAGE);
    expect(COST_CHANGE_REQUIRED_MESSAGE).toMatch(/«A costo»/);
  });

  it('con motivo de la lista pasa; un motivo inventado, no', () => {
    expect(
      updateCoilSchema.safeParse({
        unitCostPerKg: '2.5',
        reason: 'NC 123',
        costReason: 'SUPPLIER_CREDIT_NOTE',
      }).success,
    ).toBe(true);
    expect(
      updateCoilSchema.safeParse({ unitCostPerKg: '2.5', reason: 'x', costReason: 'VENDER_BARATO' })
        .success,
    ).toBe(false);
  });

  it('lo que no toca el costo no pide motivo', () => {
    expect(updateCoilSchema.safeParse({ notes: 'golpe en el borde' }).success).toBe(true);
  });

  it('el motivo viaja también en «Editar compra» y arma la nota del kardex', () => {
    expect(
      commitReceivedPurchaseEditSchema.parse({ reason: 'precio', costReason: 'TYPING_ERROR' })
        .costReason,
    ).toBe('TYPING_ERROR');
    expect(costChangeNote('TYPING_ERROR', 'tipeé 2,69')).toBe('Error de digitación: tipeé 2,69');
  });
});
