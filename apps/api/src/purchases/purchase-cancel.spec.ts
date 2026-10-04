import type { InventoryItemType } from '@prisma/client';
import { lastOwnMovementByLiveItem, laterMovementsWhere } from './purchase-cancel';

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

/**
 * D-382 (cc15b, P2-2) — qué bloquea la anulación. En producto terminado, una entrada ajena
 * posterior no; en bobina, sí. Lo anulado nunca. Todo dentro de la consulta, antes del límite.
 */
describe('laterMovementsWhere', () => {
  const own = (id: number, itemId: string, itemType: InventoryItemType, type = 'IN') => ({
    id: BigInt(id),
    itemId,
    itemType,
    type,
    reversalOfId: null,
    reversals: [],
  });

  it('producto terminado: solo lo que no es entrada; bobina: todo lo posterior', () => {
    const where = laterMovementsWhere([own(10, 'prod', 'PRODUCT'), own(11, 'coil', 'COIL')]);
    expect(where).toEqual({
      OR: [
        { itemId: 'prod', id: { gt: 10n }, type: { not: 'IN' } },
        { itemId: 'coil', id: { gt: 11n } },
      ],
      reversalOfId: null,
      reversals: { none: {} },
      id: { notIn: [10n, 11n] },
    });
  });

  it('nunca bloquea más que antes: cada condición nueva es la de antes más, como mucho, «no es entrada»', () => {
    // La regla de antes, tal cual estaba en `assertNothingMovedAfter` (cc15a).
    const before = (movements: Parameters<typeof laterMovementsWhere>[0]) =>
      [...lastOwnMovementByLiveItem(movements)].map(([itemId, id]) => ({ itemId, id: { gt: id } }));
    const sets = [
      [own(1, 'p', 'PRODUCT')],
      [own(1, 'c', 'COIL'), own(2, 'c', 'COIL', 'ADJUST')],
      [own(1, 'p', 'PRODUCT'), own(2, 'q', 'PRODUCT'), own(3, 'c', 'COIL')],
      [own(4, 'c', 'COIL', 'ADJUST')],
    ];
    for (const set of sets) {
      const now = laterMovementsWhere(set)?.OR ?? [];
      expect(now.map(({ itemId, id }) => ({ itemId, id }))).toEqual(before(set));
      for (const clause of now) {
        const { itemId: _i, id: _d, ...extra } = clause as Record<string, unknown>;
        expect(Object.keys(extra).length === 0 || extra.type !== undefined).toBe(true);
        if (extra.type !== undefined) expect(extra).toEqual({ type: { not: 'IN' } });
      }
    }
  });

  it('sin nada vigente no hay consulta', () => {
    expect(
      laterMovementsWhere([
        { ...own(20, 'prod', 'PRODUCT'), reversals: [{ id: 21n }] },
        { ...own(21, 'prod', 'PRODUCT', 'OUT'), reversalOfId: 20n },
      ]),
    ).toBeNull();
  });
});
