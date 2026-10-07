import type { Prisma } from '@prisma/client';
import { lockDocuments } from './document-locks';
import { LockOrderConflict, lockCoilRows, markBalanceHeld } from './row-locks';

/**
 * cc30 — la puerta de documentos con un `tx` simulado: qué tabla pide, en qué orden, con qué ids
 * y cuándo usa `NOWAIT`. La concurrencia de verdad la prueba `lock-order.db-spec.ts`.
 */
interface Call {
  table: string;
  ids: string[];
  nowait: boolean;
}

function fakeTx(options: { busy?: string[] } = {}) {
  const calls: Call[] = [];
  const tx = {
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      const table = /FROM "([a-z_]+)"/.exec(sql)?.[1] ?? '?';
      const ids = (values[0] as string[]) ?? [];
      const nowait = sql.includes('NOWAIT');
      calls.push({ table, ids, nowait });
      if (nowait && ids.some((id) => options.busy?.includes(id))) {
        return Promise.reject(
          Object.assign(new Error('could not obtain lock on row'), { meta: { code: '55P03' } }),
        );
      }
      return Promise.resolve(ids.map((id) => ({ id })));
    }),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, calls };
}

const A = '0000000a-0000-4000-8000-000000000000';
const B = '0000000b-0000-4000-8000-000000000000';
const C = '0000000c-0000-4000-8000-000000000000';

describe('cc30 — lockDocuments', () => {
  it('toma las clases en el orden canónico y los ids ordenados, sin duplicados ni nulos', async () => {
    const { tx, calls } = fakeTx();
    const out = await lockDocuments(tx, {
      reservations: [C, A, null, A],
      productionOrders: [B],
      salesOrders: [C.toUpperCase(), undefined],
      quotations: [A],
    });
    expect(calls.map((c) => c.table)).toEqual([
      'quotations',
      'sales_orders',
      'production_orders',
      'reservations',
    ]);
    expect(calls.every((c) => !c.nowait)).toBe(true);
    expect(calls[3]?.ids).toEqual([A, C]);
    expect(out.salesOrders).toEqual([C]);
    expect(out.quotationReservations).toEqual([]);
  });

  it('no vuelve a pedir lo que la transacción ya tiene', async () => {
    const { tx, calls } = fakeTx();
    await lockDocuments(tx, { salesOrders: [A], productionOrders: [B] });
    await lockDocuments(tx, { salesOrders: [A] });
    expect(calls).toHaveLength(2);
  });

  it('una clase anterior a otra ya tomada se pide con NOWAIT', async () => {
    const { tx, calls } = fakeTx();
    await lockDocuments(tx, { productionOrders: [B] });
    await lockDocuments(tx, { salesOrders: [A] });
    expect(calls[1]).toEqual({ table: 'sales_orders', ids: [A], nowait: true });
  });

  it('un id menor que uno ya tomado de la misma clase se pide con NOWAIT, y solo lo nuevo', async () => {
    const { tx, calls } = fakeTx();
    await lockDocuments(tx, { reservations: [B] });
    await lockDocuments(tx, { reservations: [A, B] });
    expect(calls[1]).toEqual({ table: 'reservations', ids: [A], nowait: true });
  });

  it('un id mayor en la misma clase espera como siempre (sigue en orden)', async () => {
    const { tx, calls } = fakeTx();
    await lockDocuments(tx, { reservations: [A] });
    await lockDocuments(tx, { reservations: [C] });
    expect(calls[1]?.nowait).toBe(false);
  });

  it('con inventario en mano, cualquier documento nuevo va con NOWAIT', async () => {
    const coils = fakeTx();
    await lockCoilRows(coils.tx, [A]);
    await lockDocuments(coils.tx, { salesOrders: [B] });
    expect(coils.calls.at(-1)).toEqual({ table: 'sales_orders', ids: [B], nowait: true });

    const balances = fakeTx();
    markBalanceHeld(balances.tx);
    await lockDocuments(balances.tx, { reservations: [B] });
    expect(balances.calls.at(-1)?.nowait).toBe(true);
  });

  it('ocupado con NOWAIT sale como conflicto de orden (el 409), y nombra la clase', async () => {
    const { tx } = fakeTx({ busy: [A] });
    await lockDocuments(tx, { productionOrders: [B] });
    const error = await lockDocuments(tx, { salesOrders: [A] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LockOrderConflict);
    expect((error as Error).message).toContain('pedido');
  });

  it('un error que no es de bloqueo sale tal cual', async () => {
    const { tx } = fakeTx();
    (tx.$queryRaw as unknown as jest.Mock).mockRejectedValueOnce(new Error('otra cosa'));
    await expect(lockDocuments(tx, { quotations: [A] })).rejects.toThrow('otra cosa');
  });
});
