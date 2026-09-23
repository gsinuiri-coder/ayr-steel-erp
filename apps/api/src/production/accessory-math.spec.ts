import {
  accessoryEdgeScrap,
  accessoryEffectiveWidthMm,
  accessoryPiecesPerPass,
  Decimal,
  kgPerMeter,
  piecesMeters,
  piecesTheoreticalKg,
} from '@ayr/shared';

/**
 * Aritmética de los accesorios de cobertura (D-248).
 *
 * El accesorio sale de la **misma** bobina que el resto de coberturas, pero la roladora usa
 * el ancho completo del rollo con un solo desarrollo por corte: cada pasada devuelve
 * `N = piso(ancho ÷ desarrollo)` piezas del largo de la pasada, y el sobrante lateral es el
 * canto. Todo lo que sigue verifica que las dos lecturas de una misma pasada —los metros que
 * se venden y los kilos que la bobina pierde— salgan de la misma cuenta.
 *
 * Bobina de referencia: la del brief, 1 200 mm de ancho y 0.30 mm de espesor, acero a 7.85.
 */
const coil = { widthMm: '1200.00', thicknessMm: '0.30', densityFactor: '7.8500' };

describe('accessoryPiecesPerPass (D-248)', () => {
  it('cuenta las piezas de una pasada con el piso de la división', () => {
    // 1200 ÷ 300 = 4 exactas: el ejemplo del dueño, cumbrera de 300 mm de desarrollo.
    expect(accessoryPiecesPerPass('1200.00', '300.00')).toBe(4);
  });

  it('descarta el resto: tres piezas y un canto, no tres piezas y media', () => {
    // 1200 ÷ 350 = 3.43 → 3 piezas y 150 mm de canto.
    expect(accessoryPiecesPerPass('1200.00', '350.00')).toBe(3);
  });

  it('devuelve null cuando el desarrollo no entra ni una vez en el ancho', () => {
    expect(accessoryPiecesPerPass('1200.00', '1250.00')).toBeNull();
  });

  it('devuelve null con geometría inutilizable en vez de dividir por cero', () => {
    expect(accessoryPiecesPerPass('0', '300.00')).toBeNull();
    expect(accessoryPiecesPerPass('1200.00', '0')).toBeNull();
  });
});

describe('accessoryEffectiveWidthMm (D-248, D-b)', () => {
  it('reparte el ancho completo entre las piezas de la pasada', () => {
    // 4 piezas de un rollo de 1200: cada una se lleva 300 mm y no sobra canto.
    expect(accessoryEffectiveWidthMm('1200.00', '300.00')?.toFixed(2)).toBe('300.00');
  });

  it('carga el canto al metro vendido y no al cierre', () => {
    // 3 piezas de 350 mm en 1200 mm: 150 mm de canto repartidos entre las tres.
    // 1200 ÷ 3 = 400 mm de ancho efectivo, no 350.
    expect(accessoryEffectiveWidthMm('1200.00', '350.00')?.toFixed(2)).toBe('400.00');
  });

  it('es null cuando la bobina no da ni una pieza', () => {
    expect(accessoryEffectiveWidthMm('1200.00', '1250.00')).toBeNull();
  });
});

describe('la pasada cierra: metros, kilos y canto son la misma cuenta', () => {
  // El ejemplo del brief: desarrollo 300 mm, dos pasadas de 3.00 m → 8 piezas, 24 ML.
  const developmentMm = '300.00';
  const passes = [{ lengthMm: '3000.00', qty: 2 }];
  const piecesPerPass = accessoryPiecesPerPass(coil.widthMm, developmentMm)!;
  const effectiveWidthMm = accessoryEffectiveWidthMm(coil.widthMm, developmentMm)!;

  it('convierte pasadas en piezas y metros lineales', () => {
    expect(piecesPerPass).toBe(4);
    const pieces = passes.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty * piecesPerPass }));
    expect(pieces[0]?.qty).toBe(8);
    // 8 piezas × 3 m = 24 ML de accesorio al kardex.
    expect(piecesMeters(pieces).toFixed(3)).toBe('24.000');
  });

  it('saca de la bobina el ancho completo de cada pasada, ni más ni menos', () => {
    // La verdad física: 2 pasadas × 3 m × 1200 mm × 0.30 mm × (7.85 × 1.01) = 17.126 kg.
    const perPassKg = piecesTheoreticalKg(coil, passes);
    expect(perPassKg.toFixed(3)).toBe('17.126');

    // La cuenta que el dominio corre de verdad: las **piezas**, con el ancho efectivo. Es el
    // mismo kilo salvo el residuo de redondeo que `theoreticalKgPerPiece` deja al llevar
    // **cada pieza** a la escala de kilos: ocho piezas angostas redondean ocho veces donde
    // dos pasadas anchas redondean dos. El residuo está acotado a medio gramo por pieza y lo
    // absorbe el ajuste de cierre (`roofingCloseAdjustmentPen`), igual que el resto del
    // dominio. Lo que **no** puede pasar es que se separen por el ancho, que es lo que
    // verifica la cota de abajo.
    const pieces = passes.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty * piecesPerPass }));
    const byEffectiveWidth = piecesTheoreticalKg(
      { ...coil, widthMm: effectiveWidthMm.toString() },
      pieces,
    );
    expect(byEffectiveWidth.toFixed(3)).toBe('17.128');
    const totalPieces = pieces.reduce((acc, p) => acc + p.qty, 0);
    const residue = byEffectiveWidth.minus(perPassKg).abs();
    expect(residue.lte(new Decimal('0.0005').times(totalPieces))).toBe(true);
  });

  it('promete por metro lo mismo que después consume', () => {
    // Lo que la línea de venta reserva por metro (`theoreticalKgForMeters` vía `kgPerMeter`)
    // por los metros producidos tiene que dar el kilo de la pasada. Es la invariante entera
    // de D-b: si el ancho efectivo no fuera `ancho ÷ N`, el pedido reservaría de más o de
    // menos y la diferencia aparecería al cerrar como una merma que nadie encargó.
    //
    // `kgPerMeter` no redondea —es el intermedio, no el resultado—, así que esta es la cuenta
    // limpia: 24 ML × 300 mm × 0.30 mm × 7.9285 ÷ 1e6.
    const reservedKg = kgPerMeter({ ...coil, widthMm: effectiveWidthMm.toString() }).times(
      new Decimal('24'),
    );
    expect(reservedKg.toFixed(3)).toBe('17.126');
  });

  it('mide el canto sin emitir un movimiento por él', () => {
    // Desarrollo exacto: 4 × 300 = 1200, no sobra nada.
    const exact = accessoryEdgeScrap(coil.widthMm, developmentMm)!;
    expect(exact.edgeMm.toFixed(2)).toBe('0.00');
    expect(exact.edgeRatio.toFixed(4)).toBe('0.0000');

    // Desarrollo de 350: 3 × 350 = 1050, sobran 150 mm — el 12.5 % del ancho.
    const withEdge = accessoryEdgeScrap(coil.widthMm, '350.00')!;
    expect(withEdge.piecesPerPass).toBe(3);
    expect(withEdge.edgeMm.toFixed(2)).toBe('150.00');
    expect(withEdge.edgeRatio.toFixed(4)).toBe('0.1250');
  });
});

describe('el borde del ajuste 1: N cambia entre el ancho nominal y el real', () => {
  // El caso que pidió el dueño: desarrollo 305 mm.
  //   nominal 1200 ÷ 305 = 3.93 → 3 piezas por pasada
  //   rollo real 1220 ÷ 305 = 4.00 → 4 piezas por pasada
  // Cotizar y producir dan números distintos, y el que manda al producir es el del rollo.
  const developmentMm = '305.00';

  it('cuenta 3 piezas con el ancho nominal y 4 con el rollo real', () => {
    expect(accessoryPiecesPerPass('1200.00', developmentMm)).toBe(3);
    expect(accessoryPiecesPerPass('1220.00', developmentMm)).toBe(4);
  });

  it('el ancho efectivo se mueve con N, y con él el kilo por metro', () => {
    // Nominal: 1200 ÷ 3 = 400 mm por metro vendido.
    expect(accessoryEffectiveWidthMm('1200.00', developmentMm)?.toFixed(2)).toBe('400.00');
    // Real: 1220 ÷ 4 = 305 mm. El metro producido se lleva **menos** material que el
    // cotizado, así que la corrida rinde de más — pero el aviso se muestra igual: lo que no
    // puede pasar es que nadie se entere de que el plan se armó con otra cuenta.
    expect(accessoryEffectiveWidthMm('1220.00', developmentMm)?.toFixed(2)).toBe('305.00');
  });

  it('la diferencia de rendimiento no es un detalle: 18 ML contra 24 ML por dos pasadas', () => {
    const passes = [{ lengthMm: '3000.00', qty: 2 }];
    const nominalPieces = accessoryPiecesPerPass('1200.00', developmentMm)!;
    const realPieces = accessoryPiecesPerPass('1220.00', developmentMm)!;
    const metersWith = (n: number) =>
      piecesMeters(passes.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty * n }))).toFixed(3);
    expect(metersWith(nominalPieces)).toBe('18.000');
    expect(metersWith(realPieces)).toBe('24.000');
  });
});
