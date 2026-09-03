import { BadRequestException } from '@nestjs/common';
import { deriveCuttingOrderStatus, expandWidthCounts, validateWidthBudget } from './cutting-math';

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
