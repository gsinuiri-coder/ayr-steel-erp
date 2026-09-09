import { BadRequestException } from '@nestjs/common';
import {
  Decimal,
  describePieces,
  piecesCount,
  piecesFromPlanMeters,
  piecesMeters,
  piecesTheoreticalKg,
  remainingPlanPieces,
  roofingConsumptionDeviation,
  roofingPlanOverrun,
  roofingPlanProgress,
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

// ---------------------------------------------------------------------------
// D-146 — el plan de corte es un tope duro
// ---------------------------------------------------------------------------

describe('roofingPlanProgress / roofingPlanOverrun (D-146)', () => {
  // El ejemplo del pedido, tal cual: 100 ML de plan, 80 ya reportados, el nuevo no puede
  // pasar de 20.
  const plan = [{ lengthMm: '4000.00', qty: 25 }]; // 25 × 4 m = 100 ML

  it('deja pasar exactamente lo que falta y rechaza un metro más', () => {
    const progress = roofingPlanProgress(plan, '80.000');
    expect(progress.planMeters.toFixed(3)).toBe('100.000');
    expect(progress.remainingMeters.toFixed(3)).toBe('20.000');
    expect(roofingPlanOverrun(progress, '20.000').toFixed(3)).toBe('0.000');
    expect(roofingPlanOverrun(progress, '20.001').toFixed(3)).toBe('0.001');
  });

  it('no tiene tolerancia: el borde exacto pasa y el siguiente milímetro no', () => {
    const progress = roofingPlanProgress(plan, '99.999');
    expect(roofingPlanOverrun(progress, '0.001').isZero()).toBe(true);
    expect(roofingPlanOverrun(progress, '0.002').gt(0)).toBe(true);
  });

  it('un histórico ya excedido deja el restante en cero y rechaza el siguiente reporte', () => {
    // Datos anteriores a D-146: se reportaron 120 ML contra un plan de 100. No se tocan —
    // la regla mira hacia adelante y solo corta lo que venga después.
    const progress = roofingPlanProgress(plan, '120.000');
    expect(progress.reportedMeters.toFixed(3)).toBe('120.000');
    expect(progress.remainingMeters.toFixed(3)).toBe('0.000');
    expect(roofingPlanOverrun(progress, '4.000').toFixed(3)).toBe('24.000');
  });

  it('sin plan de corte no hay tope que aplicar', () => {
    const progress = roofingPlanProgress([], '0.000');
    expect(progress.hasPlan).toBe(false);
    expect(roofingPlanOverrun(progress, '999.000').isZero()).toBe(true);
  });
});

describe('remainingPlanPieces (D-146)', () => {
  it('descuenta por largo y nunca baja de cero', () => {
    const plan = [
      { lengthMm: '4200.00', qty: 10 },
      { lengthMm: '6000.00', qty: 5 },
    ];
    const left = remainingPlanPieces(plan, [
      { lengthMm: '4200.00', qty: 3 },
      // Un largo que el plan no tiene: no descuenta de ninguna línea (el plan es editable y
      // el reporte es libre). El tope global de metros sí lo cuenta.
      { lengthMm: '3000.00', qty: 2 },
      { lengthMm: '6000.00', qty: 9 },
    ]);
    expect(left).toEqual([
      { lengthMm: '4200.00', qty: 7 },
      { lengthMm: '6000.00', qty: 0 },
    ]);
  });
});

describe('piecesFromPlanMeters (D-147)', () => {
  const plan = [
    { lengthMm: '4200.00', qty: 10 },
    { lengthMm: '6000.00', qty: 5 },
  ];

  it('reparte en el orden del plan cuando el reparto glotón cierra', () => {
    const split = piecesFromPlanMeters(plan, [], '42.000');
    expect(split.ok && split.pieces).toEqual([{ lengthMm: '4200.00', qty: 10 }]);
  });

  it('completa con la línea siguiente', () => {
    const split = piecesFromPlanMeters(plan, [], '48.000');
    expect(split.ok && split.pieces).toEqual([
      { lengthMm: '4200.00', qty: 10 },
      { lengthMm: '6000.00', qty: 1 },
    ]);
  });

  it('retrocede cuando el glotón no cierra pero la respuesta existe', () => {
    // Glotón por orden de plan se lleva una plancha de 4.20 y se queda con 1.80 m que no
    // cierran; la respuesta es una sola plancha de 6.00 m.
    const split = piecesFromPlanMeters(plan, [], '6.000');
    expect(split.ok && split.pieces).toEqual([{ lengthMm: '6000.00', qty: 1 }]);
  });

  it('no reofrece planchas que ya se reportaron', () => {
    const split = piecesFromPlanMeters(plan, [{ lengthMm: '4200.00', qty: 10 }], '12.000');
    expect(split.ok && split.pieces).toEqual([{ lengthMm: '6000.00', qty: 2 }]);
  });

  it('falla en vez de redondear cuando no sale un número entero de planchas', () => {
    // 45.500 no sale de ninguna combinación de 4.20 y 6.00 (45.000 sí: 5 × 4.20 + 4 × 6.00,
    // y por eso la búsqueda es exacta y no glotona).
    const split = piecesFromPlanMeters(plan, [], '45.500');
    expect(split.ok).toBe(false);
    expect(!split.ok && split.reason).toContain('no salen de un número entero de planchas');
  });

  it('no deja pasar más metros de los que el plan tiene pendientes', () => {
    const split = piecesFromPlanMeters(plan, [], '100.000');
    expect(split.ok).toBe(false);
    expect(!split.ok && split.reason).toContain('72.000 m pendientes');
  });

  it('una orden sin plan no admite captura por metros', () => {
    const split = piecesFromPlanMeters([], [], '10.000');
    expect(split.ok).toBe(false);
  });
});

describe('piecesTheoreticalKg (D-146)', () => {
  it('es la misma cuenta que usa el API para el kardex', () => {
    const plan = [{ lengthMm: '4200.00', qty: 10 }];
    expect(piecesTheoreticalKg(coil, plan).toFixed(3)).toBe(
      roofingTheoreticalKg(coil, plan).toFixed(3),
    );
    // El kilo se redondea **por plancha** (10.8801 → 10.880) y recién después se suma, que
    // es lo que hace el kardex: 10 × 10.880.
    expect(piecesTheoreticalKg(coil, plan).toFixed(3)).toBe('108.800');
  });
});

/**
 * D-154. La desviación del kilo declarado es lo único que quedó del tope duro de D-146, y
 * la diferencia es entera: antes había que **falsear** el dato para poder guardarlo.
 */
describe('roofingConsumptionDeviation (D-154)', () => {
  const base = { theoreticalKg: '100.000', alreadyDeclaredKg: '0', planKg: null };

  it('calla dentro de la banda de ±10 %', () => {
    expect(roofingConsumptionDeviation({ ...base, declaredKg: '109.000' })).toBeNull();
    expect(roofingConsumptionDeviation({ ...base, declaredKg: '91.000' })).toBeNull();
    expect(roofingConsumptionDeviation({ ...base, declaredKg: '100.000' })).toBeNull();
  });

  it('avisa por encima y dice cuánto', () => {
    const note = roofingConsumptionDeviation({ ...base, declaredKg: '125.000' });
    expect(note).toContain('25.0 % por encima');
  });

  it('avisa por debajo y sugiere el dígito que falta', () => {
    // El caso real: 12.5 en vez de 125. Sin aviso, el cierre reconcilia contra una cifra
    // que nadie miró y el despunte sale con signo cambiado.
    const note = roofingConsumptionDeviation({ ...base, declaredKg: '12.500' });
    expect(note).toContain('por debajo');
    expect(note).toContain('falte un dígito');
  });

  it('avisa cuando el acumulado pasa el kilo teórico del plan, y no lanza', () => {
    const note = roofingConsumptionDeviation({
      theoreticalKg: '100.000',
      declaredKg: '100.000',
      alreadyDeclaredKg: '400.000',
      planKg: '450.000',
    });
    expect(note).toContain('pasa los 450.000 kg');
  });

  it('sin plan de corte no inventa el segundo aviso', () => {
    expect(
      roofingConsumptionDeviation({
        theoreticalKg: '100.000',
        declaredKg: '100.000',
        alreadyDeclaredKg: '9999.000',
        planKg: null,
      }),
    ).toBeNull();
  });
});
