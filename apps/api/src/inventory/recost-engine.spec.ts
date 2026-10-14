import { Decimal } from '@ayr/shared';
import {
  averageOutCost,
  prorateDelta,
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
 * El caso de cc52 con datos de muestra: un producto con carga inicial, salidas a tiempo, ocho
 * salidas de septiembre grabadas después de la compra de octubre (al promedio de ese momento) y
 * una salida de octubre. La tabla esperada es la del informe al dueño.
 */
function sampleRows(): RecostRow[] {
  const avgOld = '74.5763';
  const avgLate = '70.7924';
  const out = (id: string, qty: string, avg: string) =>
    row(id, 'OUT', qty, d(qty).times(avg).toFixed(4));
  return [
    row('1', 'IN', '1061', '79125.4543'),
    out('2', '645', avgOld), // agosto, a tiempo
    out('3', '24', avgLate), // 03/09, grabada el 07/10
    out('4', '15', avgLate),
    out('5', '100', avgLate),
    out('6', '12', avgLate),
    out('7', '94', avgLate),
    out('8', '7', avgLate),
    out('9', '14', avgLate),
    out('10', '50', avgOld), // 19/09, anulada
    row('11', 'IN', '50', d('50').times(avgOld).toFixed(4), 'REVERSAL', '10'),
    out('12', '42', avgOld), // 27/09
    out('13', '100', avgLate), // 30/09, grabada el 07/10
    row('14', 'IN', '740', '50971.2000'), // compra del 07/10
    out('15', '250', avgLate), // 07/10
  ];
}

const SEPTEMBER = new Set(['3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13']);

describe('replayItem (D-649)', () => {
  it('reproduce la tabla del caso de cc52: +1 384.91 / −462.87 / −922.04', () => {
    const rows = sampleRows();
    const result = replayItem(rows, { start: 0 });
    const sum = (ids: (id: string) => boolean) =>
      result.deltas.filter((x) => ids(x.id)).reduce((s, x) => s.plus(x.delta), new Decimal(0));
    expect(sum((id) => SEPTEMBER.has(id)).toFixed(2)).toBe('1384.91');
    expect(sum((id) => id === '15').toFixed(2)).toBe('-462.87');
    expect(result.deltas).toHaveLength(9);
    const recordedValue = stockBefore(rows, rows.length).value;
    expect(result.qty.toFixed(3)).toBe('498.000');
    expect(result.value.minus(recordedValue).toFixed(2)).toBe('-922.04');
    expect(result.value.div(result.qty).toFixed(4)).toBe('68.9409');
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
    // Desde la salida de octubre, con lo de septiembre tal como quedó grabado, el promedio es el
    // del momento de grabar: no hay nada que corregir.
    expect(replayItem(sampleRows(), { start: 14 }).deltas).toEqual([]);
    // Desde la compra, con septiembre corregido a mano, sí cambia la salida de octubre.
    const rows = sampleRows().map((r) =>
      ['3', '4', '5', '6', '7', '8', '9', '13'].includes(r.id)
        ? { ...r, effective: r.qty.times('74.5763') }
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
