import { BadRequestException } from '@nestjs/common';
import {
  Decimal,
  describePieces,
  piecesCount,
  piecesMeters,
  thicknessWithinTolerance,
} from '@ayr/shared';
import {
  derivePiecesPlan,
  metersFromKg,
  roofingCloseAdjustmentPen,
  roofingCloseScrap,
  roofingCost,
  roofingTheoreticalKg,
  type CoilGeometry,
} from './roofing-math';

/**
 * Aritmética de coberturas (D-047, D-083, D-089). La bobina de referencia es un rollo
 * prepintado típico: 1 100 mm de ancho, 0.30 mm de espesor, acero a 7.85.
 */
const coil: CoilGeometry = { widthMm: '1100.00', thicknessMm: '0.30', densityFactor: '7.8500' };

describe('roofingTheoreticalKg (D-047)', () => {
  it('calcula el kilo desde la geometría de la bobina y el largo rolado', () => {
    // 1100 × 0.30 × 4200 × 7.85 / 1e6 = 10.8801 kg por plancha de 4.20 m
    const kg = roofingTheoreticalKg(coil, [{ lengthMm: '4200.00', qty: 1 }]);
    expect(kg.toFixed(3)).toBe('10.880');
  });

  it('suma los largos distintos de un mismo reporte', () => {
    const kg = roofingTheoreticalKg(coil, [
      { lengthMm: '4200.00', qty: 3 },
      { lengthMm: '6000.00', qty: 2 },
    ]);
    // 3 × 10.880 + 2 × 15.543 = 32.640 + 31.086
    expect(kg.toFixed(3)).toBe('63.726');
  });

  it('un rollo más ancho consume más kilo por el mismo largo: el ancho es el de la bobina', () => {
    const ancho = roofingTheoreticalKg({ ...coil, widthMm: '1220.00' }, [
      { lengthMm: '4200.00', qty: 1 },
    ]);
    const angosto = roofingTheoreticalKg(coil, [{ lengthMm: '4200.00', qty: 1 }]);
    expect(ancho.gt(angosto)).toBe(true);
  });
});

describe('derivePiecesPlan (D-084, Fase 7 D-093)', () => {
  it('copia los subítems del pedido cuando los trae', () => {
    const pieces = derivePiecesPlan(
      [
        { lengthMm: '4200.00', qty: 3 },
        { lengthMm: '6000.00', qty: 2 },
      ],
      null,
      '10.000',
    );
    expect(pieces).toEqual([
      { lineNumber: 1, lengthMm: '4200.00', qty: 3 },
      { lineNumber: 2, lengthMm: '6000.00', qty: 2 },
    ]);
  });

  it('una plancha de catálogo sin subítems deriva un solo largo de la receta', () => {
    const pieces = derivePiecesPlan([], '2500.00', '2.4');
    // Hacia arriba con Decimal (D-003): 2.4 planchas pedidas son 3 planchas a producir.
    expect(pieces).toEqual([{ lineNumber: 1, lengthMm: '2500.00', qty: 3 }]);
  });

  it('sin subítems y sin largo de receta no hay plan', () => {
    expect(derivePiecesPlan([], null, '5.000')).toEqual([]);
  });
});

describe('piecesMeters y describePieces (D-083)', () => {
  it('los metros de la línea son Σ cantidad × largo', () => {
    const pieces = [
      { lengthMm: '4200.00', qty: 3 },
      { lengthMm: '6000.00', qty: 2 },
    ];
    expect(piecesMeters(pieces).toFixed(3)).toBe('24.600');
    expect(piecesCount(pieces)).toBe(5);
  });

  it('la descripción lleva los largos al comprobante en metros', () => {
    expect(
      describePieces([
        { lengthMm: '4200.00', qty: 3 },
        { lengthMm: '6000.00', qty: 2 },
      ]),
    ).toBe('3 × 4.20 m, 2 × 6.00 m');
  });
});

describe('thicknessWithinTolerance (D-086)', () => {
  it('acepta el espesor nominal exacto', () => {
    expect(thicknessWithinTolerance('0.30', '0.30')).toBe(true);
  });

  it('acepta la desviación de laminación dentro de la tolerancia, en los dos sentidos', () => {
    expect(thicknessWithinTolerance('0.32', '0.30')).toBe(true);
    expect(thicknessWithinTolerance('0.28', '0.30')).toBe(true);
  });

  it('rechaza un espesor fuera de tolerancia', () => {
    expect(thicknessWithinTolerance('0.33', '0.30')).toBe(false);
    expect(thicknessWithinTolerance('0.45', '0.30')).toBe(false);
  });
});

describe('roofingCloseScrap (D-089)', () => {
  it('sin consumo declarado no hay merma: el default es el teórico', () => {
    const r = roofingCloseScrap({
      declaredKg: new Decimal('63.726'),
      reportedKg: new Decimal('63.726'),
      remainingKg: new Decimal('1136.274'),
    });
    expect(r.scrapKg.toFixed(3)).toBe('0.000');
    expect(r.scrapRatio.isZero()).toBe(true);
  });

  it('el despunte es lo declarado por encima de lo teórico', () => {
    const r = roofingCloseScrap({
      declaredKg: new Decimal('67.000'),
      reportedKg: new Decimal('63.726'),
      remainingKg: new Decimal('1136.274'),
    });
    expect(r.scrapKg.toFixed(3)).toBe('3.274');
    // Ratio sobre lo **consumido**, no sobre lo montado: 3.274 / 67 ≈ 4.9 %.
    expect(r.scrapRatio.times(100).toFixed(1)).toBe('4.9');
  });

  it('el saldo que quedó montado y no se consumió no cuenta como merma', () => {
    // La diferencia con D-057: en drywall los 1 136 kg restantes serían merma; acá la
    // bobina sigue en el almacén y solo se baja de la roladora.
    const r = roofingCloseScrap({
      declaredKg: new Decimal('63.726'),
      reportedKg: new Decimal('63.726'),
      remainingKg: new Decimal('1136.274'),
    });
    expect(r.scrapKg.isZero()).toBe(true);
  });
});

describe('roofingCost (D-056, D-090)', () => {
  it('el producto bueno absorbe el material y el despunte', () => {
    const cost = roofingCost({
      reportsCostPen: new Decimal('254.9040'),
      scrapCostPen: new Decimal('13.0960'),
      outputQty: new Decimal('24.600'),
    });
    expect(cost.materialCostPen.toFixed(4)).toBe('268.0000');
    expect(cost.overheadCostPen.toFixed(4)).toBe('0.0000');
    expect(cost.unitCostPen.toFixed(4)).toBe('10.8943');
  });

  it('divide por metros y no por piezas: el divisor es decimal', () => {
    const cost = roofingCost({
      reportsCostPen: new Decimal('100.0000'),
      scrapCostPen: new Decimal('0.0000'),
      outputQty: new Decimal('7.500'),
    });
    expect(cost.unitCostPen.toFixed(4)).toBe('13.3333');
  });

  it('una corrida sin producto bueno no se puede costear', () => {
    expect(() =>
      roofingCost({
        reportsCostPen: new Decimal('10'),
        scrapCostPen: new Decimal('0'),
        outputQty: new Decimal('0'),
      }),
    ).toThrow(BadRequestException);
  });
});

describe('roofingCloseAdjustmentPen', () => {
  it('el ajuste cierra la diferencia contra lo que ya entró reporte a reporte', () => {
    const adjust = roofingCloseAdjustmentPen(new Decimal('268.0000'), [
      { qty: new Decimal('24.600'), unitCostPen: '10.3620' },
    ]);
    // 268.00 − (24.6 × 10.3620) = 268.00 − 254.9052
    expect(adjust.toFixed(4)).toBe('13.0948');
  });

  it('puede ser negativo si el redondeo de los reportes fue hacia arriba y no hubo despunte', () => {
    const adjust = roofingCloseAdjustmentPen(new Decimal('100.0000'), [
      { qty: new Decimal('3.000'), unitCostPen: '33.3334' },
    ]);
    expect(adjust.isNegative()).toBe(true);
  });
});

describe('metersFromKg', () => {
  it('estima los metros que salen de un saldo con la geometría del rollo', () => {
    // 2.5905 kg por metro con 1100 × 0.30 × 7.85
    expect(metersFromKg(coil, '259.050').toFixed(3)).toBe('100.000');
  });

  it('no divide por cero cuando la geometría no da kilo', () => {
    expect(metersFromKg({ ...coil, thicknessMm: '0.00' }, '100.000').toFixed(3)).toBe('0.000');
  });
});
