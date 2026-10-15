import { Decimal } from '@ayr/shared';
import {
  amountCreditLines,
  NO_CREDITS,
  priceCreditLines,
  prorate,
  qtyCreditLines,
  remainingOf,
  zeroCreditLines,
  type AffectedLine,
  type LineCredits,
} from './credit-note-lines';

const d = (v: string) => new Decimal(v);

/** Dos líneas de muestra: 20 u a S/ 60 (70.80 con IGV) y 400 u a S/ 1 (1.18 con IGV). */
function lines(): AffectedLine[] {
  return [
    {
      id: 'a',
      lineNumber: 1,
      qty: d('20'),
      subtotalPen: d('1200'),
      igvPen: d('216'),
      totalPen: d('1416'),
      unitPricePen: '60.0000',
      description: 'Cobertura de muestra',
      productId: 'p1',
      unit: 'NIU',
      salesOrderItemId: 'oa',
    },
    {
      id: 'b',
      lineNumber: 2,
      qty: d('400'),
      subtotalPen: d('400'),
      igvPen: d('72'),
      totalPen: d('472'),
      unitPricePen: '1.0000',
      description: 'Tornillo de muestra',
      productId: 'p2',
      unit: 'NIU',
      salesOrderItemId: 'ob',
    },
  ];
}

const sum = (xs: { totalPen: string }[]) =>
  xs.reduce((a, x) => a.plus(x.totalPen), new Decimal(0)).toFixed(2);

describe('qtyCreditLines (01, 02, 06, 07)', () => {
  it('la nota total copia el importe de cada línea entera (D-169)', () => {
    const out = qtyCreditLines(lines(), null, new Map());
    expect(out.map((l) => [l.qty, l.totalPen])).toEqual([
      ['20.000', '1416.0000'],
      ['400.000', '472.0000'],
    ]);
  });

  it('por cantidad: la parte se valoriza al unitario derivado', () => {
    const out = qtyCreditLines(lines(), [{ affectedItemId: 'a', qty: '5' }], new Map());
    expect(out[0]).toMatchObject({ qty: '5.000', subtotalPen: '300.0000', totalPen: '354.0000' });
  });

  it('no acredita más de lo que queda ni una línea ajena', () => {
    const credited = new Map<string, LineCredits>([
      [
        'a',
        {
          ...NO_CREDITS,
          qty: d('18'),
          byQty: { subtotal: d('1080'), igv: d('194.4'), total: d('1274.4') },
        },
      ],
    ]);
    expect(() => qtyCreditLines(lines(), [{ affectedItemId: 'a', qty: '3' }], credited)).toThrow(
      'le quedan 2.000',
    );
    expect(() => qtyCreditLines(lines(), [{ affectedItemId: 'x', qty: '1' }], new Map())).toThrow(
      'no pertenece',
    );
    // La total acredita solo lo que queda: 2 u de la línea 1, que cierra con el resto.
    const total = qtyCreditLines(lines(), null, credited);
    expect(total[0]).toMatchObject({ qty: '2.000', totalPen: '141.6000' });
  });

  it('cc54: después de una rebaja, la total acredita lo que queda, no el importe del papel', () => {
    // Rebaja de S/ 94.40 con IGV en la línea 1 (05).
    const credited = new Map<string, LineCredits>([
      ['a', { ...NO_CREDITS, byAmount: { subtotal: d('80'), igv: d('14.4'), total: d('94.4') } }],
    ]);
    const total = qtyCreditLines(lines(), [{ affectedItemId: 'a', qty: '20' }], credited);
    expect(total[0]).toMatchObject({ qty: '20.000', totalPen: '1321.6000' });
    // Una parte, a lo que queda por unidad: 5 × 56 = 280 + IGV.
    const part = qtyCreditLines(lines(), [{ affectedItemId: 'a', qty: '5' }], credited);
    expect(part[0]).toMatchObject({ subtotalPen: '280.0000', totalPen: '330.4000' });
  });
});

describe('priceCreditLines (05)', () => {
  it('rebaja la diferencia de precio sobre las unidades facturadas', () => {
    const out = priceCreditLines(
      lines(),
      [{ affectedItemId: 'a', unitPriceWithIgvPen: '66.08' }],
      new Map(),
    );
    // (70.80 − 66.08) × 20 = 94.40 con IGV.
    expect(out[0]).toMatchObject({ qty: '20.000', subtotalPen: '80.0000', totalPen: '94.4000' });
  });

  it('precio nuevo cero acredita exactamente lo que queda', () => {
    const out = priceCreditLines(
      lines(),
      [{ affectedItemId: 'b', unitPriceWithIgvPen: '0' }],
      new Map(),
    );
    expect(out[0]).toMatchObject({ totalPen: '472.0000' });
  });

  it('el precio nuevo tiene que ser menor que el vigente, y sobre unidades que quedan', () => {
    expect(() =>
      priceCreditLines(lines(), [{ affectedItemId: 'a', unitPriceWithIgvPen: '70.80' }], new Map()),
    ).toThrow('menor que el vigente (S/ 70.80 con IGV)');
    const returned = new Map<string, LineCredits>([
      [
        'a',
        {
          ...NO_CREDITS,
          qty: d('20'),
          byQty: { subtotal: d('1200'), igv: d('216'), total: d('1416') },
        },
      ],
    ]);
    expect(() =>
      priceCreditLines(lines(), [{ affectedItemId: 'a', unitPriceWithIgvPen: '1' }], returned),
    ).toThrow('acreditada por completo');
  });

  it('después de una devolución parcial, rebaja solo lo que sigue facturado', () => {
    const credited = new Map<string, LineCredits>([
      [
        'a',
        {
          ...NO_CREDITS,
          qty: d('5'),
          byQty: { subtotal: d('300'), igv: d('54'), total: d('354') },
        },
      ],
    ]);
    const out = priceCreditLines(
      lines(),
      [{ affectedItemId: 'a', unitPriceWithIgvPen: '59' }],
      credited,
    );
    // 15 u × (70.80 − 59) = 177 con IGV.
    expect(out[0]).toMatchObject({ qty: '15.000', totalPen: '177.0000' });
  });
});

describe('amountCreditLines (04)', () => {
  it('la cabecera suma exactamente el monto y se reparte por lo que queda', () => {
    const out = amountCreditLines(lines(), '100.00', new Map());
    expect(sum(out)).toBe('100.00');
    const sub = out.reduce((a, l) => a.plus(l.subtotalPen), new Decimal(0));
    expect(sub.toFixed(2)).toBe('84.75');
    // La línea 1 pesa 1416 de 1888: tres cuartos.
    expect(out[0]?.totalPen).toBe('75.0000');
  });

  it('todo lo que queda: cada línea toma su resto', () => {
    const out = amountCreditLines(lines(), '1888', new Map());
    expect(out.map((l) => l.totalPen)).toEqual(['1416.0000', '472.0000']);
  });

  it('no pasa lo que queda', () => {
    expect(() => amountCreditLines(lines(), '1888.01', new Map())).toThrow(
      'pasa lo que queda por acreditar (S/ 1888.00)',
    );
  });

  it('prorate reparte exacto y el resto va a la de mayor peso', () => {
    const parts = prorate(d('10'), [d('1'), d('1'), d('1')]);
    expect(parts.reduce((a, p) => a.plus(p), new Decimal(0)).toFixed(4)).toBe('10.0000');
    expect(prorate(d('5'), [d('0')])).toEqual([d('0')]);
  });
});

describe('zeroCreditLines (03, 13)', () => {
  it('el 03 lleva solo lo corregido, con importe cero', () => {
    const out = zeroCreditLines(lines(), [
      { affectedItemId: 'b', description: 'Tornillo 1" corregido' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      qty: '400.000',
      totalPen: '0.0000',
      description: 'Tornillo 1" corregido',
    });
    expect(() =>
      zeroCreditLines(lines(), [{ affectedItemId: 'b', description: 'Tornillo de muestra' }]),
    ).toThrow('igual a la facturada');
  });

  it('el 13 lleva todas las líneas en cero', () => {
    const out = zeroCreditLines(lines(), null);
    expect(out.map((l) => l.totalPen)).toEqual(['0.0000', '0.0000']);
  });

  it('remainingOf resta cantidad solo de los motivos de cantidad', () => {
    const rest = remainingOf(lines()[0]!, {
      qty: d('5'),
      byQty: { subtotal: d('300'), igv: d('54'), total: d('354') },
      byAmount: { subtotal: d('80'), igv: d('14.4'), total: d('94.4') },
    });
    expect(rest.qty.toFixed(0)).toBe('15');
    expect(rest.amounts.total.toFixed(2)).toBe('967.60');
  });
});
