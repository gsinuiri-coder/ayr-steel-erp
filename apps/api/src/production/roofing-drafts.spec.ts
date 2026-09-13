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
    coils: [{ coilId: 'c1', coilCode: 'B-1', remainingKg: new Decimal('500'), geometry }],
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
        coils: [{ coilId: 'c1', coilCode: 'B-1', remainingKg: new Decimal('100'), geometry }],
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
        { coilId: 'c1', coilCode: 'B-1', remainingKg: new Decimal('500'), geometry },
        { coilId: 'c2', coilCode: 'B-2', remainingKg: new Decimal('500'), geometry },
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
