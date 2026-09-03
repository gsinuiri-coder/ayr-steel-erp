import { BadRequestException } from '@nestjs/common';
import { Decimal, theoreticalKg, theoreticalKgPerPiece } from '@ayr/shared';
import {
  allocateStripKg,
  closeAdjustmentPen,
  productionCost,
  type StripAllocationRow,
} from './production-math';

function rows(...remaining: string[]): StripAllocationRow[] {
  return remaining.map((kg, i) => ({
    consumptionId: `c${i}`,
    coilId: `coil${i}`,
    coilCode: `FLJ-${i}`,
    remainingKg: new Decimal(kg),
  }));
}

describe('theoreticalKgPerPiece (D-047, D-059)', () => {
  it('calcula el kilo de un perfil desde su geometría y el factor de densidad', () => {
    // 90 mm × 0.50 mm × 3000 mm = 135 000 mm³; × 7.85 / 1e6 = 1.05975 kg → 1.060 kg.
    expect(
      theoreticalKgPerPiece({
        widthMm: '90',
        thicknessMm: '0.50',
        pieceLengthMm: '3000',
        densityFactor: '7.85',
      }).toFixed(3),
    ).toBe('1.060');
  });

  it('escala linealmente con el largo de la pieza', () => {
    const tres = theoreticalKgPerPiece({
      widthMm: '100',
      thicknessMm: '1',
      pieceLengthMm: '3000',
      densityFactor: '7.85',
    });
    const seis = theoreticalKgPerPiece({
      widthMm: '100',
      thicknessMm: '1',
      pieceLengthMm: '6000',
      densityFactor: '7.85',
    });
    expect(seis.div(tres).toFixed(3)).toBe('2.000');
  });

  it('multiplica el kilo por pieza sin pasar por `number` (D-003)', () => {
    expect(theoreticalKg(250, '1.060').toFixed(3)).toBe('265.000');
  });
});

describe('allocateStripKg (reparto entre los flejes asignados)', () => {
  it('gasta los flejes en el orden en que se montaron', () => {
    const allocations = allocateStripKg(rows('100', '100'), '150');
    expect(allocations).toHaveLength(2);
    expect(allocations[0]?.kg.toFixed(3)).toBe('100.000');
    expect(allocations[1]?.kg.toFixed(3)).toBe('50.000');
  });

  it('no toca los flejes que no hacen falta', () => {
    const allocations = allocateStripKg(rows('100', '100'), '40');
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.consumptionId).toBe('c0');
  });

  it('la suma repartida es exactamente lo pedido, sin residuo de milésimas', () => {
    const allocations = allocateStripKg(rows('33.333', '33.333', '33.334'), '100');
    const total = allocations.reduce((acc, a) => acc.plus(a.kg), new Decimal(0));
    expect(total.toFixed(3)).toBe('100.000');
  });

  it('salta las filas ya agotadas', () => {
    const allocations = allocateStripKg(rows('0', '80'), '80');
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.consumptionId).toBe('c1');
  });

  it('falla nombrando el faltante si los flejes asignados no alcanzan', () => {
    expect(() => allocateStripKg(rows('50'), '80')).toThrow(BadRequestException);
    expect(() => allocateStripKg(rows('50'), '80')).toThrow(/50\.000 kg asignados/);
  });

  it('falla si las piezas reportadas no consumen material', () => {
    expect(() => allocateStripKg(rows('50'), '0')).toThrow(BadRequestException);
  });
});

describe('productionCost (D-056)', () => {
  it('reparte todo el material —piezas y merma— entre las piezas buenas', () => {
    const cost = productionCost({ reportsCostPen: '900', scrapCostPen: '100', pieces: 500 });
    expect(cost.materialCostPen.toFixed(4)).toBe('1000.0000');
    expect(cost.totalCostPen.toFixed(4)).toBe('1000.0000');
    expect(cost.unitCostPen.toFixed(4)).toBe('2.0000');
  });

  it('deja el overhead en cero: es el hook de D-035, no un costo de v1', () => {
    const cost = productionCost({ reportsCostPen: '1000', scrapCostPen: '0', pieces: 100 });
    expect(cost.overheadCostPen.toFixed(4)).toBe('0.0000');
    expect(cost.totalCostPen.eq(cost.materialCostPen)).toBe(true);
  });

  it('no costea una corrida sin piezas buenas', () => {
    expect(() => productionCost({ reportsCostPen: '10', scrapCostPen: '0', pieces: 0 })).toThrow(
      BadRequestException,
    );
  });
});

describe('closeAdjustmentPen (D-056: el kardex cierra sin residuo)', () => {
  it('traslada a las piezas el costo de la merma de proceso', () => {
    // 900 piezas entraron a S/ 8; la corrida costó S/ 9 600 con la merma incluida.
    const adjust = closeAdjustmentPen('9600', [
      { pieces: 500, unitCostPen: '8.0000' },
      { pieces: 400, unitCostPen: '8.0000' },
    ]);
    expect(adjust.toFixed(4)).toBe('2400.0000');
  });

  it('se lleva también el residuo de redondeo del costo unitario de cada reporte', () => {
    // 3 piezas por S/ 10 → 3.3333 por pieza; las piezas entraron valiendo 9.9999.
    const adjust = closeAdjustmentPen('10', [{ pieces: 3, unitCostPen: '3.3333' }]);
    expect(adjust.toFixed(4)).toBe('0.0001');
  });

  it('puede ser negativo cuando el redondeo de los reportes fue hacia arriba', () => {
    // 3 piezas por S/ 20 → 6.6667 por pieza; entraron valiendo 20.0001.
    const adjust = closeAdjustmentPen('20', [{ pieces: 3, unitCostPen: '6.6667' }]);
    expect(adjust.toFixed(4)).toBe('-0.0001');
  });

  it('es cero cuando no hubo merma ni residuo', () => {
    const adjust = closeAdjustmentPen('1000', [{ pieces: 250, unitCostPen: '4.0000' }]);
    expect(adjust.isZero()).toBe(true);
  });
});
