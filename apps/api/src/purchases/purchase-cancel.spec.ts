import { lastOwnMovementByLiveItem } from './purchase-cancel';

/**
 * D-372 (cc15) — contra qué se mide «posterior» al anular una compra. Un ítem que la compra ya
 * no tiene vigente (todo revertido) no cuenta; uno con ingreso vigente se mide contra su último
 * ingreso; uno sin ingreso (un flete), contra su último movimiento.
 */
describe('lastOwnMovementByLiveItem', () => {
  const mv = (
    id: number,
    itemId: string,
    reversalOf: number | null,
    { reversed = false, type = 'IN' }: { reversed?: boolean; type?: string } = {},
  ) => ({
    id: BigInt(id),
    itemId,
    type,
    reversalOfId: reversalOf === null ? null : BigInt(reversalOf),
    reversals: reversed ? [{ id: BigInt(id + 1000) }] : [],
  });

  it('un producto cambiado por «Editar compra» (ingreso revertido) no cuenta; el nuevo sí', () => {
    const result = lastOwnMovementByLiveItem([
      mv(10, 'prod-viejo', null, { reversed: true }), // ingreso original, revertido
      mv(11, 'prod-viejo', 10, { type: 'OUT' }), // su reversa
      mv(12, 'prod-nuevo', null), // ingreso vigente del producto nuevo
    ]);
    expect([...result]).toEqual([['prod-nuevo', 12n]]);
  });

  it('un ítem con ingreso vigente se mide contra el último ingreso (recosteo B1)', () => {
    const result = lastOwnMovementByLiveItem([
      mv(20, 'coil-1', null, { reversed: true }),
      mv(21, 'coil-1', 20, { type: 'OUT' }),
      mv(22, 'coil-1', null),
    ]);
    expect(result.get('coil-1')).toBe(22n);
  });

  it('un ajuste de costo propio posterior no corre la referencia: el consumo entre medio se sigue viendo (P1-1)', () => {
    // Ingreso 30, un despacho ajeno 31 (no es de la compra) y el ajuste proporcional 32.
    const result = lastOwnMovementByLiveItem([
      mv(30, 'prod-a', null),
      mv(32, 'prod-a', null, { type: 'ADJUST' }),
    ]);
    expect(result.get('prod-a')).toBe(30n);
  });

  it('sin ingreso propio (un flete, D-043), contra su último movimiento', () => {
    const result = lastOwnMovementByLiveItem([mv(40, 'coil-2', null, { type: 'ADJUST' })]);
    expect(result.get('coil-2')).toBe(40n);
  });

  it('una compra sin nada vigente no tiene contra qué medir', () => {
    expect(
      lastOwnMovementByLiveItem([
        mv(50, 'p', null, { reversed: true }),
        mv(51, 'p', 50, { type: 'OUT' }),
      ]).size,
    ).toBe(0);
  });
});
