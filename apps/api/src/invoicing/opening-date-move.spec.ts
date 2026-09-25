import { Decimal } from '@ayr/shared';
import {
  assertOpeningMoveNotApplied,
  planMissingOuts,
  planOpeningMoves,
  type OpeningItem,
} from './opening-date-move';

/**
 * D-285: la carga inicial se fecha el 2026-08-01 (HISTORICAL_LOAD_START), una sola vez, y solo
 * en los ítems que no tienen movimientos anteriores a esa fecha.
 */
const item = (over: Partial<OpeningItem>): OpeningItem => ({
  key: 'PRODUCT:upvc',
  label: 'UPVC36MT',
  imports: [{ id: '1', date: '2026-09-22' }],
  earliestOther: '2026-09-24',
  ...over,
});

describe('planOpeningMoves (D-285)', () => {
  it('mueve la carga inicial a la fecha efectiva', () => {
    expect(planOpeningMoves([item({})], '2026-08-01')).toEqual([
      expect.objectContaining({
        action: 'MOVE',
        from: ['2026-09-22'],
        to: '2026-08-01',
        movementIds: ['1'],
      }),
    ]);
  });

  it('no mueve un ítem con movimientos anteriores a la fecha efectiva', () => {
    const [plan] = planOpeningMoves([item({ earliestOther: '2026-07-20' })], '2026-08-01');
    expect(plan).toMatchObject({ action: 'SKIP' });
    expect(plan?.reason).toContain('2026-07-20');
  });

  it('un movimiento del mismo día de la fecha efectiva no impide moverla', () => {
    expect(planOpeningMoves([item({ earliestOther: '2026-08-01' })], '2026-08-01')[0]?.action).toBe(
      'MOVE',
    );
  });

  it('lo que ya está en la fecha efectiva no se toca', () => {
    expect(
      planOpeningMoves([item({ imports: [{ id: '1', date: '2026-08-01' }] })], '2026-08-01')[0]
        ?.action,
    ).toBe('ALREADY');
  });
});

describe('assertOpeningMoveNotApplied (D-285)', () => {
  it('la excepción no se repite: con la auditoría del movimiento, se niega', () => {
    expect(() => {
      assertOpeningMoveNotApplied(true);
    }).toThrow('ya se aplicó');
    expect(() => {
      assertOpeningMoveNotApplied(false);
    }).not.toThrow();
  });
});

describe('planMissingOuts (D-285)', () => {
  const D = (v: number): Decimal => new Decimal(v);
  it('agrega la salida si el kardex (ya refechado) la sostiene; si no, a revisión', () => {
    const plan = planMissingOuts(
      [
        { id: 'a', itemKey: 'P', date: '2026-08-11', qty: D(50) },
        { id: 'b', itemKey: 'P', date: '2026-08-12', qty: D(60) },
      ],
      new Map([
        [
          'P',
          { openingDate: '2026-08-01', movements: [{ date: '2026-08-01', signedQty: D(100) }] },
        ],
      ]),
    );
    expect(plan.map((p) => p.action)).toEqual(['ADD', 'REVIEW']);
    expect(plan[1]?.reason).toContain('negativo');
  });

  it('antes del saldo inicial, sigue sin salida (revisión)', () => {
    const plan = planMissingOuts(
      [{ id: 'a', itemKey: 'P', date: '2026-08-11', qty: D(5) }],
      new Map([
        [
          'P',
          { openingDate: '2026-09-22', movements: [{ date: '2026-09-22', signedQty: D(100) }] },
        ],
      ]),
    );
    expect(plan[0]).toMatchObject({ action: 'REVIEW' });
  });
});
