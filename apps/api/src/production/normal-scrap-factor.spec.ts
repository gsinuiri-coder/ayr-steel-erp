import {
  NORMAL_SCRAP_RATE_PCT,
  equivalentMeters,
  kgPerMeter,
  standardDensityFactor,
  theoreticalKgPerPiece,
  toDecimal,
} from '@ayr/shared';

/**
 * D-165 — centinela del factor de merma normal.
 *
 * Lo que estos casos protegen no es la aritmética (es una multiplicación) sino **dónde vive**
 * el 1 %. La forma fácil de aplicarlo era editar a mano `finishes.density_factor` acabado por
 * acabado, y eso deja tres problemas que ningún test de cálculo detecta: el dato físico y la
 * política de la empresa mezclados en una columna que nadie puede volver a separar, acabados
 * nuevos naciendo sin el factor, y las dos cuentas —kilo por pieza y kilo por metro— pudiendo
 * divergir. Por eso lo que se verifica acá es que **las dos cuentas apliquen exactamente el
 * mismo factor** y que el factor sea el de la constante, no un número tipeado dos veces.
 *
 * Si alguien vuelve a meter el 1 % en los datos, estos casos siguen pasando y el material se
 * cuenta **dos** veces: el centinela real contra eso es que la densidad de un acabado no se
 * toque, y por eso el 1 % está acá y no allá.
 */
describe('merma normal absorbida en el estándar (D-165)', () => {
  const geometry = { widthMm: '1100.00', thicknessMm: '0.30', densityFactor: '7.8500' };

  it('el factor es el 1 % que fijó el dueño', () => {
    expect(NORMAL_SCRAP_RATE_PCT).toBe('1.0000');
    expect(standardDensityFactor('7.8500').toFixed(6)).toBe('7.928500');
  });

  it('el kilo por metro y el kilo por pieza aplican el MISMO factor', () => {
    // La pregunta que las dos responden es la misma —cuánto material se lleva esto— y por eso
    // no pueden llevar factores distintos: los kilos que un pedido reserva por metro y los
    // que el reporte de planta descuenta por metro serían dos números para el mismo hecho.
    const porMetro = kgPerMeter(geometry);
    const porPieza = theoreticalKgPerPiece({ ...geometry, pieceLengthMm: '1000.00' });
    // A la escala de kilos: `theoreticalKgPerPiece` redondea porque es un resultado final y
    // `kgPerMeter` no porque es un paso intermedio de `equivalentMeters`. Esa diferencia es
    // deliberada y anterior a D-165; lo que no puede diferir es el factor.
    expect(porPieza.toFixed(3)).toBe(porMetro.toDecimalPlaces(3).toFixed(3));
  });

  it('el estándar consume 1 % más material que el prisma perfecto', () => {
    const conMerma = kgPerMeter(geometry);
    const sinMerma = toDecimal(geometry.widthMm)
      .times(geometry.thicknessMm)
      .times(1000)
      .times(geometry.densityFactor)
      .div(1_000_000);
    expect(conMerma.div(sinMerma).toFixed(4)).toBe('1.0100');
  });

  it('el metro equivalente de un saldo baja, no sube', () => {
    // La consecuencia que el dueño va a ver: el mismo rollo promete menos metros. Es lo que
    // la decisión quiere — el 1 % dejó de ser una sorpresa al cerrar y pasó a ser el plan.
    const metros = equivalentMeters(geometry, '259.050');
    expect(metros?.toFixed(3)).toBe('99.010');
  });
});
