import { CoilKind, CoilStatus, FinishKind, Prisma } from '@prisma/client';
import { drywallPieceWeightCheck } from '@ayr/shared';
import {
  describeDrywallStrip,
  drywallStripMismatch,
  drywallStripSpec,
  drywallStripWhere,
} from './drywall-strip';

/**
 * D-344 — la definición única del fleje compatible con un perfil de drywall, y el aviso del peso
 * declarado contra el teórico (que comparte el módulo de pruebas porque es la misma cuenta del SKU).
 */

const D = (v: string) => new Prisma.Decimal(v);

describe('drywallStripSpec: lo que un SKU declara del fleje', () => {
  it('espesor y ancho a dos decimales', () => {
    expect(drywallStripSpec({ thicknessMm: D('0.45'), widthMm: D('115') })).toEqual({
      thicknessMm: '0.45',
      widthMm: '115.00',
    });
  });

  it.each([
    [null, D('115'), 'NO_THICKNESS'],
    [D('0'), D('115'), 'NO_THICKNESS'],
    [D('-1'), D('115'), 'NO_THICKNESS'],
    [D('0.45'), null, 'NO_WIDTH'],
    [D('0.45'), D('0'), 'NO_WIDTH'],
  ] as const)('espesor %s y ancho %s: %s', (thicknessMm, widthMm, reason) => {
    expect(drywallStripSpec({ thicknessMm, widthMm })).toEqual({ noFloorReason: reason });
  });
});

describe('drywallStripWhere: el filtro de flejes abiertos que sirven', () => {
  it('flejes (no bobinas), abiertos, de la línea, galvanizados, y espesor y ancho exactos', () => {
    expect(
      drywallStripWhere({ businessLineId: 'bl-1', thicknessMm: '0.45', widthMm: '115.00' }),
    ).toEqual({
      kind: CoilKind.STRIP,
      status: CoilStatus.OPEN,
      businessLineId: 'bl-1',
      finish: { kind: FinishKind.GALVANIZADO },
      thicknessMm: '0.45',
      widthMm: '115.00',
    });
  });
});

describe('drywallStripMismatch: validar el fleje que eligió el operario', () => {
  const spec = { thicknessMm: '0.45', widthMm: '115.00' };
  const strip = (over: Record<string, unknown> = {}) => ({
    code: 'FLEJE-9',
    finishKind: FinishKind.GALVANIZADO as FinishKind | null,
    thicknessMm: D('0.45'),
    widthMm: D('115.00'),
    ...over,
  });

  it('el fleje que sirve devuelve null', () => {
    expect(drywallStripMismatch(strip(), spec)).toBeNull();
  });

  it.each([
    ['otro acabado', { finishKind: FinishKind.PREPINTADO }],
    ['sin acabado', { finishKind: null }],
    ['otro espesor', { thicknessMm: D('0.50') }],
    ['espesor cercano (sin tolerancia)', { thicknessMm: D('0.46') }],
    ['otro ancho', { widthMm: D('116.00') }],
  ])('%s: se rechaza y el mensaje nombra acabado, espesor y ancho', (_n, over) => {
    const message = drywallStripMismatch(strip(over), spec);
    expect(message).toBe(
      'FLEJE-9 no es compatible con el perfil: se necesita un fleje de acabado galvanizado, 0.45 mm de espesor y 115.00 mm de ancho (los datos del SKU)',
    );
  });

  it('describeDrywallStrip nombra los tres datos', () => {
    expect(describeDrywallStrip(spec)).toBe(
      'un fleje de acabado galvanizado, 0.45 mm de espesor y 115.00 mm de ancho',
    );
  });
});

describe('drywallPieceWeightCheck: el kg/pieza declarado contra el teórico (aviso de D-344)', () => {
  // OMEGA045 real: fleje de 115 mm, 3 m de largo, 0.45 mm de espesor, densidad 7.85 t/m³ + 1 % (D-165):
  // 115 × 3000 × 0.45 × 7.85 × 1.01 / 1 000 000 = 1.231 kg.
  const base = {
    widthMm: '115.00',
    lengthMm: '3000.00',
    thicknessMm: '0.45',
    densityFactor: '7.8500',
  };

  it('un peso cerca del teórico no avisa', () => {
    const r = drywallPieceWeightCheck({ ...base, pieceWeightKg: '1.220' });
    expect(r?.theoreticalKg).toBe('1.231');
    expect(r?.warn).toBe(false);
    expect(Number(r?.deviationPct)).toBeLessThan(1);
  });

  it('los marcadores 1.00 mm / 1.000 kg de PERFILH, PERFILU y R39GALV090 sí avisan', () => {
    const r = drywallPieceWeightCheck({
      widthMm: '1.00',
      lengthMm: '6000.00',
      thicknessMm: '0.45',
      densityFactor: '7.8500',
      pieceWeightKg: '1.000',
    });
    // Teórico con 1 mm de ancho: 0.021 kg; declarado 1.000 kg → desvío enorme.
    expect(r?.warn).toBe(true);
  });

  it('el umbral es del 5 %: 4.9 % no avisa y 5.1 % sí', () => {
    const theoretical = 1.231;
    const under = drywallPieceWeightCheck({
      ...base,
      pieceWeightKg: (theoretical * 1.049).toFixed(3),
    });
    const over = drywallPieceWeightCheck({
      ...base,
      pieceWeightKg: (theoretical * 1.051).toFixed(3),
    });
    expect(under?.warn).toBe(false);
    expect(over?.warn).toBe(true);
  });

  it('el desvío es absoluto: un peso por debajo del teórico también avisa', () => {
    const r = drywallPieceWeightCheck({ ...base, pieceWeightKg: '0.900' });
    expect(r?.warn).toBe(true);
  });

  it.each([
    ['ancho', { widthMm: null }],
    ['largo', { lengthMm: null }],
    ['espesor', { thicknessMm: null }],
    ['peso', { pieceWeightKg: null }],
    ['densidad', { densityFactor: null }],
  ])('sin %s no hay comparación', (_n, over) => {
    expect(drywallPieceWeightCheck({ ...base, pieceWeightKg: '1.220', ...over })).toBeNull();
  });

  it('un teórico de cero (ancho 0) no divide: sin comparación', () => {
    expect(drywallPieceWeightCheck({ ...base, widthMm: '0', pieceWeightKg: '1.000' })).toBeNull();
  });
});
