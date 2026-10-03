import { lastOwnMovementByLiveItem } from './purchase-cancel';

/**
 * D-372 (cc15) — contra qué se mide «posterior» al anular una compra. Un ítem que la compra ya
 * no tiene vigente (todo revertido) no cuenta; uno vigente se mide contra su último movimiento.
 */
describe('lastOwnMovementByLiveItem', () => {
  const mv = (id: number, itemId: string, reversalOf: number | null, reversed = false) => ({
    id: BigInt(id),
    itemId,
    reversalOfId: reversalOf === null ? null : BigInt(reversalOf),
    reversals: reversed ? [{ id: BigInt(id + 1000) }] : [],
  });

  it('un producto cambiado por «Editar compra» (ingreso revertido) no cuenta; el nuevo sí', () => {
    const result = lastOwnMovementByLiveItem([
      mv(10, 'prod-viejo', null, true), // ingreso original, revertido
      mv(11, 'prod-viejo', 10), // su reversa
      mv(12, 'prod-nuevo', null), // ingreso vigente del producto nuevo
    ]);
    expect([...result]).toEqual([['prod-nuevo', 12n]]);
  });

  it('un ítem vigente se mide contra su último movimiento, revertidos incluidos', () => {
    // Recosteo de bobina (D-045 / B1): ingreso revertido, su reversa y el ingreso nuevo.
    const result = lastOwnMovementByLiveItem([
      mv(20, 'coil-1', null, true),
      mv(21, 'coil-1', 20),
      mv(22, 'coil-1', null),
    ]);
    expect(result.get('coil-1')).toBe(22n);
  });

  it('una compra sin nada vigente no tiene contra qué medir', () => {
    expect(lastOwnMovementByLiveItem([mv(30, 'p', null, true), mv(31, 'p', 30)]).size).toBe(0);
  });
});
