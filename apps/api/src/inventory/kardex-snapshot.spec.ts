import { Prisma } from '@prisma/client';
import { loadKardex, qtyRowsOf, qtyRowsOfSnapshot, stockUpToDate } from './inventory-recost';

/**
 * cc58 (D-691, E-07 de audit-01): la foto del kardex que una operación lee una vez da lo mismo que
 * las lecturas que reemplaza (las filas de D-652 y el saldo a una fecha).
 */
const D = (v: string) => new Prisma.Decimal(v);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const row = (
  id: number,
  type: 'IN' | 'OUT',
  qty: string,
  cost: string,
  date: string,
  over = {},
) => ({
  id: BigInt(id),
  businessLineId: 'l',
  itemType: 'PRODUCT',
  itemId: 'p',
  type,
  qty: D(qty),
  unit: 'NIU',
  totalCost: D(cost),
  refType: type === 'IN' ? 'PURCHASE' : 'SALE',
  refId: null,
  reversalOfId: null,
  recostOfId: null,
  operationDate: day(date),
  ...over,
});

const raw = [
  row(1, 'IN', '10', '100', '2026-08-01'),
  row(2, 'OUT', '4', '40', '2026-08-05'),
  // Un recosteo de la salida: no mueve cantidad; suma costo a su fila.
  row(3, 'IN', '4', '-2', '2026-08-05', { type: 'ADJUST', recostOfId: 2n }),
  row(4, 'IN', '5', '60', '2026-08-10'),
];

function fakeTx() {
  const findMany = jest.fn(({ where }: { where: { recostOfId?: null } }) =>
    Promise.resolve(where.recostOfId === null ? raw.filter((r) => r.recostOfId === null) : raw),
  );
  return {
    tx: {
      inventoryMovement: { findMany },
      salesReturnItem: { findMany: jest.fn().mockResolvedValue([]) },
    } as never,
    findMany,
  };
}

describe('KardexSnapshot', () => {
  const item = { itemType: 'PRODUCT' as const, itemId: 'p' };

  it('las filas de cantidad de la foto son las de qtyRowsOf', async () => {
    const { tx } = fakeTx();
    const snapshot = await loadKardex(tx, item);
    expect(qtyRowsOfSnapshot(snapshot)).toEqual(await qtyRowsOf(tx, item));
  });

  it('el saldo a una fecha sale de la foto sin volver a leer', async () => {
    const { tx, findMany } = fakeTx();
    const snapshot = await loadKardex(tx, item);
    findMany.mockClear();
    const at = await stockUpToDate(tx, item, day('2026-08-06'), snapshot);
    const end = await stockUpToDate(tx, item, day('2026-12-31'), snapshot);
    expect(findMany).not.toHaveBeenCalled();
    // 10 − 4 = 6 u; 100 − (40 + 2 del recosteo) = 58.
    expect([at.qty.toString(), at.value.toString()]).toEqual(['6', '58']);
    expect([end.qty.toString(), end.value.toString()]).toEqual(['11', '118']);
    expect(await stockUpToDate(tx, item, day('2026-12-31'))).toEqual(end);
  });
});
