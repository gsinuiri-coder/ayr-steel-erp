import type { Prisma } from '@prisma/client';
import { LockOrderConflict, lockCoilRows, markBalanceHeld, sortedUniqueIds } from './row-locks';

/**
 * D-386: la puerta única de bloqueos de bobina. Una sola sentencia por id y, en una segunda toma
 * que ampliaría el conjunto fuera de orden (P3-2 de cc15b), `NOWAIT` en vez de esperar.
 */
function fakeTx(busy: string[] = []) {
  const statements: { ids: string[]; nowait: boolean }[] = [];
  const tx = {
    $queryRaw: jest.fn((strings: TemplateStringsArray, ids: string[]) => {
      const nowait = strings.join('?').includes('NOWAIT');
      statements.push({ ids, nowait });
      if (nowait && ids.some((id) => busy.includes(id))) {
        return Promise.reject(
          Object.assign(new Error('could not obtain lock on row'), { meta: { code: '55P03' } }),
        );
      }
      return Promise.resolve(ids.map((id) => ({ id })));
    }),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, statements };
}

describe('lockCoilRows (D-386)', () => {
  it('pide el conjunto entero en una sola sentencia, sin duplicados y por id', async () => {
    const { tx, statements } = fakeTx();
    await expect(lockCoilRows(tx, ['c', 'a', 'b', 'a'])).resolves.toEqual(['a', 'b', 'c']);
    expect(statements).toEqual([{ ids: ['a', 'b', 'c'], nowait: false }]);
  });

  it('volver a pedir bobinas ya tomadas no consulta', async () => {
    const { tx, statements } = fakeTx();
    await lockCoilRows(tx, ['a', 'b']);
    await expect(lockCoilRows(tx, ['b'])).resolves.toEqual(['b']);
    expect(statements).toHaveLength(1);
  });

  it('ampliar en orden (ids mayores y sin saldos en mano) espera como siempre', async () => {
    const { tx, statements } = fakeTx(['d']);
    await lockCoilRows(tx, ['a', 'b']);
    await lockCoilRows(tx, ['b', 'd']);
    expect(statements[1]).toEqual({ ids: ['b', 'd'], nowait: false });
  });

  it('ampliar con un id menor que uno ya tomado no espera: NOWAIT', async () => {
    const { tx, statements } = fakeTx();
    await lockCoilRows(tx, ['b', 'c']);
    await expect(lockCoilRows(tx, ['a', 'c'])).resolves.toEqual(['a', 'c']);
    expect(statements[1]).toEqual({ ids: ['a'], nowait: true });
  });

  it('ampliar con un saldo ya en mano no espera, aunque el id sea mayor', async () => {
    const { tx, statements } = fakeTx();
    await lockCoilRows(tx, ['a']);
    markBalanceHeld(tx);
    await lockCoilRows(tx, ['a', 'z']);
    expect(statements[1]).toEqual({ ids: ['z'], nowait: true });
  });

  it('si la bobina nueva está tomada por otra operación, sale con el conflicto (el 409 de D-386)', async () => {
    const { tx } = fakeTx(['a']);
    await lockCoilRows(tx, ['b']);
    await expect(lockCoilRows(tx, ['a'])).rejects.toBeInstanceOf(LockOrderConflict);
  });

  it('cada transacción lleva su propia cuenta', async () => {
    const one = fakeTx();
    const two = fakeTx();
    await lockCoilRows(one.tx, ['b']);
    markBalanceHeld(one.tx);
    await lockCoilRows(two.tx, ['a']);
    expect(two.statements).toEqual([{ ids: ['a'], nowait: false }]);
  });

  it('el orden es por unidades de código, el mismo del ORDER BY de un uuid', () => {
    expect(
      sortedUniqueIds([
        'f0000000-0000-0000-0000-000000000000',
        '10000000-0000-0000-0000-000000000000',
        'a0000000-0000-0000-0000-000000000000',
      ]),
    ).toEqual([
      '10000000-0000-0000-0000-000000000000',
      'a0000000-0000-0000-0000-000000000000',
      'f0000000-0000-0000-0000-000000000000',
    ]);
  });
});
