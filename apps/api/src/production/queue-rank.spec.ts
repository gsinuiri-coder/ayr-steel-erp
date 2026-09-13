import { compareQueueRank, isOverdue, type QueueRankable } from '@ayr/shared';

/**
 * D-189: el único criterio de orden de la cola de producción. `/planta` y la cola usan esta
 * misma función; si alguien la cambia, cambia en los dos lados a la vez — y este spec dice
 * cuál es el orden que el dueño decidió.
 */

const today = '2026-09-13';

function op(seq: number, overrides: Partial<QueueRankable> = {}): QueueRankable & { id: string } {
  return {
    id: `OP-${String(seq)}`,
    seq,
    priority: false,
    promisedDeliveryDate: null,
    ...overrides,
  };
}

function rank(list: (QueueRankable & { id: string })[]): string[] {
  return [...list].sort((a, b) => compareQueueRank(a, b, today)).map((o) => o.id);
}

describe('isOverdue (D-189)', () => {
  it('solo con fecha anterior a hoy', () => {
    expect(isOverdue(null, today)).toBe(false);
    expect(isOverdue('2026-09-12', today)).toBe(true);
    expect(isOverdue('2026-09-13', today)).toBe(false);
  });
});

describe('compareQueueRank (D-189)', () => {
  it('la prioridad manual va primero, aunque sea la más nueva y sin fecha', () => {
    expect(
      rank([op(1, { promisedDeliveryDate: '2026-09-01' }), op(2, { priority: true })]),
    ).toEqual(['OP-2', 'OP-1']);
  });

  it('dentro de su prioridad, las vencidas arriba', () => {
    expect(
      rank([
        op(1, { priority: true, promisedDeliveryDate: '2026-09-20' }),
        op(2, { priority: true, promisedDeliveryDate: '2026-09-10' }),
        op(3, { promisedDeliveryDate: '2026-09-15' }),
        op(4, { promisedDeliveryDate: '2026-09-11' }),
      ]),
    ).toEqual(['OP-2', 'OP-1', 'OP-4', 'OP-3']);
  });

  it('luego la fecha prometida más cercana; sin fecha al final', () => {
    expect(
      rank([
        op(1),
        op(2, { promisedDeliveryDate: '2026-09-30' }),
        op(3, { promisedDeliveryDate: '2026-09-14' }),
      ]),
    ).toEqual(['OP-3', 'OP-2', 'OP-1']);
  });

  it('empate: la orden creada primero', () => {
    expect(rank([op(7), op(3), op(5)])).toEqual(['OP-3', 'OP-5', 'OP-7']);
    expect(
      rank([
        op(9, { promisedDeliveryDate: '2026-09-01' }),
        op(4, { promisedDeliveryDate: '2026-09-01' }),
      ]),
    ).toEqual(['OP-4', 'OP-9']);
  });
});
