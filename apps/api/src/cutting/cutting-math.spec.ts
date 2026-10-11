import { BadRequestException } from '@nestjs/common';
import { Decimal } from '@ayr/shared';
import {
  deriveCuttingOrderStatus,
  expandWidthCounts,
  prorateReceptionValue,
  receptionCosts,
  validateWidthBudget,
} from './cutting-math';

describe('validateWidthBudget (RF-40)', () => {
  it('acepta un plan que cabe en el ancho de la bobina', () => {
    expect(() => {
      validateWidthBudget(
        '1220.00',
        [
          { widthMm: '600.00', stripsCount: 1 },
          { widthMm: '400.00', stripsCount: 1 },
        ],
        '20.00',
        'B001',
      );
    }).not.toThrow();
  });

  it('rechaza un plan que excede el ancho de la bobina', () => {
    expect(() => {
      validateWidthBudget('1220.00', [{ widthMm: '700.00', stripsCount: 2 }], '0.00', 'B001');
    }).toThrow(BadRequestException);
  });

  it('cuenta la merma esperada dentro del presupuesto de ancho', () => {
    expect(() => {
      validateWidthBudget('1220.00', [{ widthMm: '600.00', stripsCount: 2 }], '30.00', 'B001');
    }).toThrow(BadRequestException);
  });

  it('rechaza merma negativa', () => {
    expect(() => {
      validateWidthBudget('1220.00', [{ widthMm: '600.00', stripsCount: 1 }], '-1.00', 'B001');
    }).toThrow(BadRequestException);
  });

  it('multiplica ancho × cantidad de tiras, no solo suma filas', () => {
    // 5 tiras de 250mm = 1250mm, que ya excede una madre de 1220mm aunque sea una sola fila.
    expect(() => {
      validateWidthBudget('1220.00', [{ widthMm: '250.00', stripsCount: 5 }], '0.00', 'B001');
    }).toThrow(BadRequestException);
  });
});

describe('expandWidthCounts', () => {
  it('expande cada fila a una entrada por tira, en orden', () => {
    expect(
      expandWidthCounts([
        { widthMm: '600.00', stripsCount: 2 },
        { widthMm: '400.00', stripsCount: 1 },
      ]),
    ).toEqual(['600.00', '600.00', '400.00']);
  });
});

describe('deriveCuttingOrderStatus (RF-22, RF-40..42)', () => {
  it('SENT mientras todo sigue enviado', () => {
    expect(deriveCuttingOrderStatus(['SENT', 'SENT'])).toBe('SENT');
  });

  it('PARTIALLY_RECEIVED con una mezcla de enviado y recibido', () => {
    expect(deriveCuttingOrderStatus(['SENT', 'RECEIVED'])).toBe('PARTIALLY_RECEIVED');
  });

  it('RECEIVED cuando ya no queda ninguna SENT y algo se recibió', () => {
    expect(deriveCuttingOrderStatus(['RECEIVED', 'RECEIVED'])).toBe('RECEIVED');
    expect(deriveCuttingOrderStatus(['RECEIVED', 'CANCELLED'])).toBe('RECEIVED');
  });

  it('CANCELLED solo si nada se llegó a recibir', () => {
    expect(deriveCuttingOrderStatus(['CANCELLED', 'CANCELLED'])).toBe('CANCELLED');
  });
});

describe('prorateReceptionValue (D-597)', () => {
  it('reparte el valor de la madre por kilo y la suma cuadra exacta', () => {
    // 2 852.459 kg de fleje sobre 3 000 kg que salieron a S/ 4: S/ 12 000 enteros en los flejes.
    const shares = prorateReceptionValue('12000.0000', ['1475.410', '1377.049']);
    expect(shares.map((s) => s.toFixed(4))).toEqual(['6206.8973', '5793.1027']);
    expect(shares[0]?.plus(shares[1] ?? '0').toFixed(4)).toBe('12000.0000');
  });

  it('el fleje más pesado se lleva el redondeo', () => {
    const shares = prorateReceptionValue('100.0000', ['1', '3', '3']);
    // 100/7 = 14.2857…, 300/7 = 42.8571…; el primero de los dos de 3 kg absorbe el resto.
    expect(shares.map((s) => s.toFixed(4))).toEqual(['14.2857', '42.8572', '42.8571']);
  });

  it('sin kilos no reparte nada', () => {
    expect(prorateReceptionValue('10', [])).toEqual([]);
    expect(prorateReceptionValue('10', ['0']).map((s) => s.toFixed(4))).toEqual(['0.0000']);
  });
});

describe('prorateReceptionValue — borde de valor casi nulo (revisión cc44)', () => {
  it('el pesado nunca queda negativo aunque el total sea de milésimas', () => {
    const shares = prorateReceptionValue('0.0002', ['1', '1', '1', '1', '1.5']);
    expect(shares.every((s) => !s.isNegative())).toBe(true);
    expect(shares.reduce((a, s) => a.plus(s), new Decimal(0)).toFixed(4)).toBe('0.0002');
  });
});

describe('receptionCosts (D-597)', () => {
  it('reparte el valor, sube el costo del documento y valoriza el kerf', () => {
    // 1 500 kg a S/ 4.1234 (S/ 6 185.10) en 737.705 + 688.525 kg: 73.770 kg de kerf y borde.
    const costs = receptionCosts({
      outValuePen: '6185.1000',
      motherDocumentUnitCost: '4.1234',
      splitWeightKg: '1500.000',
      kerfLossKg: '73.770',
      childrenWeightsKg: ['737.705', '688.525'],
    });
    expect(costs.childrenValuesPen.reduce((a, v) => a.plus(v), new Decimal(0)).toFixed(4)).toBe(
      '6185.1000',
    );
    expect(costs.documentUnitCost.toFixed(4)).toBe('4.3367');
    expect(costs.kerfValuePen.toFixed(2)).toBe('304.18');
  });

  it('sin kerf el documento queda igual y el kerf vale cero', () => {
    const costs = receptionCosts({
      outValuePen: '100',
      motherDocumentUnitCost: '4',
      splitWeightKg: '25',
      kerfLossKg: '0',
      childrenWeightsKg: ['12.5', '12.5'],
    });
    expect(costs.documentUnitCost.toFixed(4)).toBe('4.0000');
    expect(costs.kerfValuePen.toFixed(4)).toBe('0.0000');
    expect(costs.childrenValuesPen.map((v) => v.toFixed(4))).toEqual(['50.0000', '50.0000']);
  });

  it('un plan degenerado sin kilos no divide por cero', () => {
    const costs = receptionCosts({
      outValuePen: '0',
      motherDocumentUnitCost: '4',
      splitWeightKg: '0',
      kerfLossKg: '0',
      childrenWeightsKg: [],
    });
    expect(costs.documentUnitCost.toFixed(4)).toBe('4.0000');
    expect(costs.kerfValuePen.toFixed(4)).toBe('0.0000');
  });
});
