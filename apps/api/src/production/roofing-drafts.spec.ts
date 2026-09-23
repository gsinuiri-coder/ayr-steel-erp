import { BadRequestException } from '@nestjs/common';
import { BACKDATE_OUT_OF_ORDER, Decimal } from '@ayr/shared';
import { checkDraftRows, type DraftCheckState } from './roofing-drafts';
import { withRowNumber } from './roofing-drafts.service';

/**
 * D-191: la validación del borrador es la misma al ingresar y al ejecutar, y acumula en orden.
 *
 * Geometría a mano: 1 000 mm × 0.50 mm, densidad 8.0 ⇒ 4 kg/m, más el 1 % de D-165 ⇒ 4.04.
 */

const geometry = { widthMm: '1000.00', thicknessMm: '0.50', densityFactor: '8.0000' };

function state(overrides: Partial<DraftCheckState> = {}): DraftCheckState {
  return {
    orderSeq: 7,
    productSku: 'COB-1',
    fixedLengthMm: null,
    planPieces: [{ lengthMm: '4000.00', qty: 10 }], // 40 m
    reportedMeters: new Decimal(0),
    coils: [
      {
        coilId: 'c1',
        coilCode: 'B-1',
        remainingKg: new Decimal('500'),
        geometry,
        piecesPerPass: null,
      },
    ],
    ...overrides,
  };
}

describe('checkDraftRows (D-191)', () => {
  it('acepta filas que entran en el plan y en la bobina, y devuelve la bobina resuelta', () => {
    const result = checkDraftRows(state(), [
      { coilId: undefined, pieces: [{ lengthMm: '4000.00', qty: 5 }] },
      { coilId: 'c1', pieces: [{ lengthMm: '4000.00', qty: 5 }] },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows.map((r) => r.coil.coilId)).toEqual(['c1', 'c1']);
      expect(result.rows[0]?.meters.toFixed(3)).toBe('20.000');
    }
  });

  it('el tope del plan (D-146) cuenta lo reportado MÁS las filas anteriores del borrador', () => {
    const result = checkDraftRows(state({ reportedMeters: new Decimal('16') }), [
      { coilId: 'c1', pieces: [{ lengthMm: '4000.00', qty: 5 }] }, // 16 + 20 = 36
      { coilId: 'c1', pieces: [{ lengthMm: '4000.00', qty: 2 }] }, // 36 + 8 = 44 > 40
    ]);
    expect(result).toMatchObject({ ok: false, rowNumber: 2 });
    if (!result.ok) expect(result.message).toMatch(/quedan 4\.000 m y esta fila suma 8\.000 m/);
  });

  it('los kilos de una bobina se acumulan entre filas', () => {
    const result = checkDraftRows(
      state({
        planPieces: [{ lengthMm: '4000.00', qty: 100 }],
        coils: [
          {
            coilId: 'c1',
            coilCode: 'B-1',
            remainingKg: new Decimal('100'),
            geometry,
            piecesPerPass: null,
          },
        ],
      }),
      [
        { coilId: 'c1', pieces: [{ lengthMm: '4000.00', qty: 5 }] }, // 80.8 kg
        { coilId: 'c1', pieces: [{ lengthMm: '4000.00', qty: 2 }] }, // 32.32 kg > 19.2
      ],
    );
    expect(result).toMatchObject({ ok: false, rowNumber: 2 });
    if (!result.ok) expect(result.message).toMatch(/el borrador ya ocupa 80\.800 kg/);
  });

  it('con varias bobinas exige indicar de cuál; una bobina bajada rechaza la fila', () => {
    const two = state({
      coils: [
        {
          coilId: 'c1',
          coilCode: 'B-1',
          remainingKg: new Decimal('500'),
          geometry,
          piecesPerPass: null,
        },
        {
          coilId: 'c2',
          coilCode: 'B-2',
          remainingKg: new Decimal('500'),
          geometry,
          piecesPerPass: null,
        },
      ],
    });
    expect(
      checkDraftRows(two, [{ coilId: undefined, pieces: [{ lengthMm: '4000.00', qty: 1 }] }]),
    ).toMatchObject({ ok: false, rowNumber: 1 });
    expect(
      checkDraftRows(state(), [{ coilId: 'cX', pieces: [{ lengthMm: '4000.00', qty: 1 }] }]),
    ).toMatchObject({ ok: false, message: 'Esa bobina no está montada en la orden' });
  });

  it('una plancha de catálogo no admite otro largo', () => {
    const result = checkDraftRows(state({ fixedLengthMm: '3000.00' }), [
      { coilId: 'c1', pieces: [{ lengthMm: '4000.00', qty: 1 }] },
    ]);
    expect(result).toMatchObject({ ok: false, rowNumber: 1 });
  });

  // -------------------------------------------------------------------------
  // D-248 — el borrador de un accesorio está en pasadas
  // -------------------------------------------------------------------------
  //
  // La fila dice «2 pasadas de 4 m»; contra el plan y contra la bobina se mide lo que de
  // verdad sale, que con 4 piezas por pasada son 8 planchas y 32 m. Si el borrador midiera
  // las pasadas como si fueran planchas, una orden de 40 m aceptaría cinco filas iguales
  // —160 m— y recién al ejecutar la última aparecería el exceso.
  const accessoryCoil = {
    coilId: 'c1',
    coilCode: 'B-1',
    remainingKg: new Decimal('500'),
    // Ancho efectivo: 1 000 ÷ 4 = 250 mm. El kilo sale igual que con el ancho completo por
    // pasada, que es la invariante de D-b.
    geometry: { widthMm: '250.00', thicknessMm: '0.50', densityFactor: '8.0000' },
    piecesPerPass: 4,
  };

  it('mide las pasadas contra el plan en las piezas que van a salir', () => {
    const result = checkDraftRows(state({ coils: [accessoryCoil] }), [
      { coilId: 'c1', pieces: [{ lengthMm: '4000.00', qty: 2 }] },
    ]);
    expect(result.ok).toBe(true);
    // 2 pasadas × 4 piezas × 4 m = 32 m, no 8 m.
    if (result.ok) expect(result.rows[0]?.meters.toFixed(3)).toBe('32.000');
  });

  it('el plan de 40 m rechaza la segunda fila, que como pasadas parecería entrar', () => {
    const result = checkDraftRows(state({ coils: [accessoryCoil] }), [
      { coilId: 'c1', pieces: [{ lengthMm: '4000.00', qty: 2 }] }, // 32 m
      { coilId: 'c1', pieces: [{ lengthMm: '4000.00', qty: 1 }] }, // +16 m = 48 m > 40
    ]);
    expect(result).toMatchObject({ ok: false, rowNumber: 2 });
    if (!result.ok) expect(result.message).toMatch(/quedan 8\.000 m y esta fila suma 16\.000 m/);
  });

  it('el kilo de la pasada sale por el ancho completo del rollo', () => {
    const result = checkDraftRows(state({ coils: [accessoryCoil] }), [
      { coilId: 'c1', pieces: [{ lengthMm: '4000.00', qty: 2 }] },
    ]);
    expect(result.ok).toBe(true);
    // 8 piezas × 4 m × 250 mm × 0.50 mm × 8.08 = 32.32 kg, que es exactamente lo mismo que
    // 2 pasadas × 4 m × 1 000 mm de ancho completo. El canto ya está adentro.
    if (result.ok) expect(result.rows[0]?.theoreticalKg.toFixed(3)).toBe('32.320');
  });
});

describe('withRowNumber (D-191)', () => {
  it('antepone la fila y conserva el code de retro-fecha (D-124)', () => {
    const err = new BadRequestException({
      code: BACKDATE_OUT_OF_ORDER,
      message: 'La fecha queda antes',
      statusCode: 400,
    });
    const wrapped = withRowNumber(err, 3) as BadRequestException;
    expect(wrapped.getStatus()).toBe(400);
    expect(wrapped.getResponse()).toMatchObject({
      code: BACKDATE_OUT_OF_ORDER,
      message: 'Fila 3: La fecha queda antes',
    });
  });
});
