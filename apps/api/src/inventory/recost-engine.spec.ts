import { Decimal } from '@ayr/shared';
import {
  averageOutCost,
  cancelSameDayReversals,
  firstNegativeDate,
  firstValidDate,
  fitsWithoutNegative,
  isRoundingNoise,
  negativeSpans,
  prorateDelta,
  qtyRowsFromMovements,
  recostAdjustTotal,
  replayItem,
  rowCostOfRecost,
  stockBefore,
  type RecostRow,
} from './recost-engine';

const d = (v: string) => new Decimal(v);

function row(
  id: string,
  type: RecostRow['type'],
  qty: string,
  total: string,
  rule: RecostRow['rule'] = type === 'OUT' ? 'AVERAGE' : 'FIXED',
  sourceId?: string,
): RecostRow {
  return { id, type, qty: d(qty), recorded: d(total), effective: d(total), rule, sourceId };
}

/**
 * La estructura del caso de cc52 con **cifras de muestra** (cc54: ninguna cifra real del negocio en
 * el repo): un producto con carga inicial, salidas a tiempo, ocho salidas de abril grabadas
 * después de la compra de mayo (al promedio de ese momento), una anulada el mismo día y una
 * salida de mayo. La compra entra un 8 % más barata que la carga.
 */
function sampleRows(): RecostRow[] {
  const avgOld = '10.0000';
  // El promedio al grabar, ya con la compra: (36 × 10 + 644) / 106.
  const avgLate = '9.4717';
  const out = (id: string, qty: string, avg: string) =>
    row(id, 'OUT', qty, d(qty).times(avg).toFixed(4));
  return [
    row('1', 'IN', '100', '1000.0000'),
    out('2', '60', avgOld), // marzo, a tiempo
    out('3', '2', avgLate), // 02/04, grabada el 06/05
    out('4', '1', avgLate),
    out('5', '10', avgLate),
    out('6', '1', avgLate),
    out('7', '9', avgLate),
    out('8', '1', avgLate),
    out('9', '1', avgLate),
    out('10', '5', avgOld), // 17/04, anulada
    row('11', 'IN', '5', d('5').times(avgOld).toFixed(4), 'REVERSAL', '10'),
    out('12', '4', avgOld), // 24/04
    out('13', '10', avgLate), // 28/04, grabada el 06/05
    row('14', 'IN', '70', '644.0000'), // compra del 06/05, a 9.20
    out('15', '25', avgLate), // 06/05
  ];
}

const LATE_MONTH = new Set(['3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13']);

describe('replayItem (D-649)', () => {
  it('reproduce la estructura del caso de cc52: el mes atrasado sube, el siguiente y el inventario bajan', () => {
    const rows = sampleRows();
    const result = replayItem(rows, { start: 0 });
    const sum = (ids: (id: string) => boolean) =>
      result.deltas.filter((x) => ids(x.id)).reduce((s, x) => s.plus(x.delta), new Decimal(0));
    // Abril: 35 u que salen a 10.00 y estaban a 9.4717: +35 × 0.5283.
    expect(sum((id) => LATE_MONTH.has(id)).toFixed(2)).toBe('18.49');
    // Mayo: 25 u a 654 / 71 (1 u a 10 más la compra) en vez de 9.4717.
    expect(sum((id) => id === '15').toFixed(2)).toBe('-6.51');
    expect(result.deltas).toHaveLength(9);
    const recordedValue = stockBefore(rows, rows.length).value;
    expect(result.qty.toFixed(3)).toBe('46.000');
    expect(result.value.minus(recordedValue).toFixed(2)).toBe('-11.98');
    expect(result.value.div(result.qty).toFixed(4)).toBe('9.2113');
  });

  it('es idempotente: con los ajustes aplicados no queda nada que corregir', () => {
    const first = replayItem(sampleRows(), { start: 0 });
    const fixed = sampleRows().map((r) => {
      const hit = first.deltas.find((x) => x.id === r.id);
      return hit ? { ...r, effective: hit.target } : r;
    });
    expect(replayItem(fixed, { start: 0 }).deltas).toEqual([]);
  });

  it('las filas anteriores a start conservan su costo efectivo', () => {
    // Desde la salida de mayo, con lo de abril tal como quedó grabado, el promedio es el
    // del momento de grabar: no hay nada que corregir.
    expect(replayItem(sampleRows(), { start: 14 }).deltas).toEqual([]);
    // Desde la compra, con abril corregido a mano, sí cambia la salida de mayo.
    const rows = sampleRows().map((r) =>
      ['3', '4', '5', '6', '7', '8', '9', '13'].includes(r.id)
        ? { ...r, effective: r.qty.times('10') }
        : r,
    );
    expect(replayItem(rows, { start: 13 }).deltas.map((x) => x.id)).toEqual(['15']);
  });

  it('una anulación sigue al costo corregido del original', () => {
    const rows = [
      row('1', 'IN', '10', '100'),
      row('2', 'IN', '10', '300'),
      row('3', 'OUT', '5', '50'), // grabada al promedio viejo
      row('4', 'IN', '5', '50', 'REVERSAL', '3'),
    ];
    const result = replayItem(rows, { start: 0 });
    expect(result.corrected.get('3')?.toFixed(4)).toBe('100.0000');
    expect(result.corrected.get('4')?.toFixed(4)).toBe('100.0000');
  });

  it('dos salidas el mismo día toman el promedio en su orden de registro', () => {
    const rows = [
      row('1', 'IN', '10', '100'),
      row('2', 'OUT', '4', '0'),
      row('3', 'OUT', '6', '0'),
      row('4', 'IN', '10', '500'),
    ];
    const result = replayItem(rows, { start: 0 });
    expect(result.corrected.get('2')?.toFixed(4)).toBe('40.0000');
    expect(result.corrected.get('3')?.toFixed(4)).toBe('60.0000');
    expect(result.value.toFixed(4)).toBe('500.0000');
  });

  it('una devolución toma la parte, por cantidad, del costo corregido de su salida', () => {
    // Devuelve 2 de las 4 unidades de una salida de otro ítem que pasó de 40 a 44.
    const rows = [row('1', 'IN', '2', '20', 'RETURN', 'x')];
    const external = new Map([
      ['x', { type: 'OUT' as const, qty: d('4'), effective: d('40'), corrected: d('44') }],
    ]);
    const result = replayItem(rows, { start: 0, external });
    expect(result.corrected.get('1')?.toFixed(4)).toBe('22.0000');
  });

  it('una devolución grabada ya al costo recosteado no se escala dos veces', () => {
    // La salida se grabó a 40, se recosteó a 100 y después se devolvió entera a 100.
    const rows = [
      row('1', 'IN', '10', '100'),
      { ...row('2', 'OUT', '4', '40'), effective: d('100') },
      row('3', 'IN', '4', '100', 'RETURN', '2'),
    ];
    const result = replayItem(rows, { start: 2 });
    expect(result.deltas).toEqual([]);
  });

  it('la anulación de un ajuste sigue la proporción de lo que anuló', () => {
    const rows = [
      row('1', 'IN', '10', '100'),
      row('2', 'ADJUST', '10', '20', 'FIXED'),
      row('3', 'ADJUST', '10', '-10', 'REVERSAL', '2'),
    ];
    const result = replayItem(rows, { start: 0, overrides: new Map([['2', d('40')]]) });
    expect(result.corrected.get('3')?.toFixed(4)).toBe('-20.0000');
  });

  it('una entrada derivada toma el costo impuesto desde su origen', () => {
    const rows = [row('1', 'IN', '3', '30'), row('2', 'OUT', '3', '30')];
    const result = replayItem(rows, { start: 0, overrides: new Map([['1', d('36')]]) });
    expect(result.corrected.get('2')?.toFixed(4)).toBe('36.0000');
  });
});

describe('ayudas', () => {
  it('averageOutCost se lleva todo el valor con la última unidad', () => {
    expect(averageOutCost({ qty: d('3'), value: d('10') }, d('3')).toFixed(4)).toBe('10.0000');
    expect(averageOutCost({ qty: d('3'), value: d('10') }, d('1')).toFixed(4)).toBe('3.3333');
    expect(averageOutCost({ qty: d('0'), value: d('10') }, d('1')).toFixed(4)).toBe('0.0000');
  });

  it('el signo del ajuste sigue al saldo', () => {
    expect(recostAdjustTotal('OUT', d('5')).toFixed(2)).toBe('-5.00');
    expect(recostAdjustTotal('IN', d('5')).toFixed(2)).toBe('5.00');
    expect(rowCostOfRecost('OUT', d('-5')).toFixed(2)).toBe('5.00');
    expect(rowCostOfRecost('ADJUST', d('-5')).toFixed(2)).toBe('-5.00');
  });

  it('prorateDelta reparte exacto y el resto va al de mayor peso', () => {
    const parts = prorateDelta(d('10'), [
      { id: 'a', recorded: d('1'), qty: d('1') },
      { id: 'b', recorded: d('2'), qty: d('1') },
    ]);
    expect(parts.get('a')?.toFixed(4)).toBe('3.3333');
    expect(parts.get('b')?.toFixed(4)).toBe('6.6667');
    const byQty = prorateDelta(d('1'), [
      { id: 'a', recorded: d('0'), qty: d('1') },
      { id: 'b', recorded: d('0'), qty: d('3') },
    ]);
    expect(byQty.get('a')?.toFixed(4)).toBe('0.2500');
    expect(prorateDelta(d('1'), []).size).toBe(0);
  });
});

describe('isRoundingNoise (revisión de cc53)', () => {
  it('una diezmilésima por unidad o menos de un céntimo es redondeo, no recosteo', () => {
    expect(isRoundingNoise(d('0.009'), d('1'))).toBe(true);
    expect(isRoundingNoise(d('0.02'), d('250'))).toBe(true);
    expect(isRoundingNoise(d('-0.025'), d('250'))).toBe(true);
    expect(isRoundingNoise(d('0.03'), d('250'))).toBe(false);
  });

  it('una salida grabada al promedio redondeado no se recostea', () => {
    // 3 u por 10: promedio exacto 3.3333…, guardado 3.3333; salen 2 u a 6.6666.
    const rows = [row('1', 'IN', '3', '10'), row('2', 'OUT', '2', '6.6666')];
    expect(replayItem(rows, { start: 0 }).deltas).toEqual([]);
  });
});

describe('D-652: salida atrasada sin dejar el kardex en negativo', () => {
  const q = (date: string, delta: string) => ({ date, delta: d(delta) });
  // Entran 10 el 01; salen 8 el 05; entran 10 el 10.
  const rows = [q('2026-08-01', '10'), q('2026-08-05', '-8'), q('2026-08-10', '10')];

  it('cabe si a su fecha y después el saldo no baja de cero', () => {
    expect(fitsWithoutNegative(rows, '2026-08-03', d('2'))).toBe(true);
    expect(fitsWithoutNegative(rows, '2026-08-03', d('3'))).toBe(false);
    expect(fitsWithoutNegative(rows, '2026-08-11', d('12'))).toBe(true);
  });

  it('sugiere la primera fecha válida (criterio de D-374)', () => {
    expect(firstValidDate(rows, '2026-08-03', d('3'), '2026-10-14')).toBe('2026-08-10');
    expect(firstValidDate(rows, '2026-08-03', d('2'), '2026-10-14')).toBe('2026-08-03');
    expect(firstValidDate(rows, '2026-08-03', d('13'), '2026-10-14')).toBeNull();
  });

  it('cc54 (D-662): una salida tampoco agrava un negativo que ya existía', () => {
    // El 05 ya salió de más (−2). Una salida del 03 lo llevaría a −7: se rechaza.
    const legacy = [q('2026-08-01', '10'), q('2026-08-05', '-12'), q('2026-08-10', '10')];
    expect(fitsWithoutNegative(legacy, '2026-08-03', d('5'))).toBe(false);
    // Después del negativo, sí: el 11 hay 8.
    expect(fitsWithoutNegative(legacy, '2026-08-11', d('5'))).toBe(true);
    // La primera fecha válida es la que ya no pasa por el negativo.
    expect(firstValidDate(legacy, '2026-08-03', d('5'), '2026-10-14')).toBe('2026-08-10');
    // Un negativo anterior a la salida no la afecta.
    const before = [q('2026-08-01', '-2'), q('2026-08-02', '10')];
    expect(fitsWithoutNegative(before, '2026-08-05', d('8'))).toBe(true);
  });
});

describe('cc54: un solo cálculo de negativos y primera fecha válida (P2-2 de cc53)', () => {
  const q = (date: string, delta: string) => ({ date, delta: d(delta) });
  const rows = [q('2026-08-01', '10'), q('2026-08-05', '-8'), q('2026-08-10', '10')];

  it('firstNegativeDate acumula las salidas nuevas en su orden y dice el día', () => {
    expect(firstNegativeDate(rows, [])).toBeNull();
    expect(firstNegativeDate(rows, [{ date: '2026-08-03', qty: d('2') }])).toBeNull();
    // Dos salidas que por separado caben y juntas no: falla el 05.
    const two = [
      { date: '2026-08-02', qty: d('1') },
      { date: '2026-08-03', qty: d('2') },
    ];
    expect(firstNegativeDate(rows, two)).toBe('2026-08-05');
    // A la fecha de la salida misma, si ya no alcanza ese día.
    expect(firstNegativeDate(rows, [{ date: '2026-08-06', qty: d('3') }])).toBe('2026-08-06');
  });

  it('fitsWithoutNegative es el mismo cálculo con una sola salida', () => {
    for (const [date, qty] of [
      ['2026-08-03', '2'],
      ['2026-08-03', '3'],
      ['2026-08-11', '12'],
      ['2026-07-30', '1'],
    ] as const) {
      expect(fitsWithoutNegative(rows, date, d(qty))).toBe(
        firstNegativeDate(rows, [{ date, qty: d(qty) }]) === null,
      );
    }
  });

  it('firstValidDate cuenta las salidas que el plan ya aceptó', () => {
    // Sola cabe el 03; con 1 ya aceptada el 02, recién el 10.
    expect(firstValidDate(rows, '2026-08-03', d('2'), '2026-10-14')).toBe('2026-08-03');
    expect(
      firstValidDate(rows, '2026-08-03', d('2'), '2026-10-14', [
        { date: '2026-08-02', qty: d('1') },
      ]),
    ).toBe('2026-08-10');
  });

  it('cc54 (D-662): con varias salidas, el negativo que ya existía también las rechaza', () => {
    const legacy = [q('2026-08-01', '10'), q('2026-08-05', '-12'), q('2026-08-10', '10')];
    const outs = [
      { date: '2026-08-02', qty: d('2') },
      { date: '2026-08-03', qty: d('3') },
    ];
    expect(firstNegativeDate(legacy, outs)).toBe('2026-08-05');
    expect(firstNegativeDate(legacy, [{ date: '2026-08-11', qty: d('8') }])).toBeNull();
  });
});

describe('cc54: pares anulados el mismo día (P3-4 de cc53)', () => {
  const mv = (
    id: string,
    date: string,
    type: 'IN' | 'OUT',
    qty: string,
    reversalOfId: string | null = null,
  ) => ({ id, date, type, qty: d(qty), reversalOfId });

  it('cancela el par del mismo día y conserva la anulación de otro día', () => {
    const kept = cancelSameDayReversals([
      mv('1', '2026-09-19', 'IN', '10'),
      mv('2', '2026-09-24', 'OUT', '5'),
      mv('3', '2026-09-24', 'IN', '5', '2'),
      mv('4', '2026-09-20', 'OUT', '3'),
      mv('5', '2026-09-25', 'IN', '3', '4'),
    ]);
    expect(kept.map((m) => m.id)).toEqual(['1', '4', '5']);
  });

  it('acepta ids bigint y string por igual', () => {
    const kept = cancelSameDayReversals([
      { id: 7n, date: '2026-09-24', reversalOfId: null },
      { id: 8n, date: '2026-09-24', reversalOfId: 7n },
    ]);
    expect(kept).toEqual([]);
  });

  it('qtyRowsFromMovements da el signo por tipo y saca los pares', () => {
    const rows = qtyRowsFromMovements([
      mv('1', '2026-09-19', 'IN', '10'),
      mv('2', '2026-09-24', 'OUT', '10'),
      mv('3', '2026-09-24', 'IN', '10', '2'),
      mv('4', '2026-09-25', 'OUT', '4'),
    ]);
    expect(rows.map((r) => [r.date, r.delta.toFixed(0)])).toEqual([
      ['2026-09-19', '10'],
      ['2026-09-25', '-4'],
    ]);
    // Sin el par, una salida nueva del 22 por 10 no ve un negativo de paso el 24.
    expect(fitsWithoutNegative(rows, '2026-09-22', d('6'))).toBe(true);
  });
});

describe('cc54: negativeSpans (P3-2 de cc53, inspect:cc53)', () => {
  const q = (date: string, delta: string) => ({ date, delta: d(delta) });

  it('abre y cierra tramos con su mínimo', () => {
    const spans = negativeSpans([
      q('2026-08-01', '5'),
      q('2026-08-02', '-7'),
      q('2026-08-03', '-1'),
      q('2026-08-04', '10'),
      q('2026-08-05', '-9'),
    ]);
    expect(spans).toEqual([
      { from: '2026-08-02', to: '2026-08-04', minQty: '-3.000' },
      { from: '2026-08-05', to: null, minQty: '-2.000' },
    ]);
  });

  it('sin negativos, sin tramos', () => {
    expect(negativeSpans([q('2026-08-01', '5'), q('2026-08-02', '-5')])).toEqual([]);
  });
});

describe('cc54 (segundo modelo P2-1): el saldo final nunca queda eximido', () => {
  const q = (date: string, delta: string) => ({ date, delta: d(delta) });
  // El kardex ya termina en −2 (historia anterior a D-652).
  const ends = [q('2026-08-01', '10'), q('2026-08-05', '-12')];

  it('una salida posterior a todo no cabe: es el «Stock insuficiente» del kardex', () => {
    expect(firstNegativeDate(ends, [{ date: '2026-08-10', qty: d('1') }])).toBe('2026-08-10');
    expect(fitsWithoutNegative(ends, '2026-08-10', d('1'))).toBe(false);
    expect(firstValidDate(ends, '2026-08-10', d('1'), '2026-10-14')).toBeNull();
  });

  it('tampoco una atrasada, aunque el punto intermedio ya fuera negativo', () => {
    expect(firstNegativeDate(ends, [{ date: '2026-08-03', qty: d('1') }])).toBe('2026-08-05');
  });
});
