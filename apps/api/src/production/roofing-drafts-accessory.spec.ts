import { Decimal, roofingReportDraftInputSchema } from '@ayr/shared';
import { checkDraftRows, mathPieces, type DraftCheckState } from './roofing-drafts';

/**
 * cc41 (D-591): la validación del borrador con filas de **accesorio** (metros de bobina, D-343).
 *
 * Geometría a mano: 1 000 mm × 0.50 mm, densidad 8.0 ⇒ 4 kg/m, más el 1 % de D-165 ⇒ 4.04.
 */

const geometry = { widthMm: '1000.00', thicknessMm: '0.50', densityFactor: '8.0000' };

function state(overrides: Partial<DraftCheckState> = {}): DraftCheckState {
  return {
    orderSeq: 9,
    productSku: 'ACC-050-GRIS',
    fixedLengthMm: null,
    planPieces: [],
    reportedMeters: new Decimal(0),
    coils: [
      { coilId: 'c1', coilCode: 'B-1', remainingKg: new Decimal('500'), geometry },
      { coilId: 'c2', coilCode: 'B-2', remainingKg: new Decimal('500'), geometry },
    ],
    accessory: { orderedMeters: new Decimal('10') },
    ...overrides,
  };
}

describe('checkDraftRows con un accesorio (cc41, D-591)', () => {
  it('mide cada fila por sus metros: kilo teórico y metros acumulados', () => {
    const result = checkDraftRows(state(), [
      { coilId: 'c1', pieces: [], meters: '3.500' },
      { coilId: 'c2', pieces: [], meters: '6.500' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows.map((r) => [r.meters.toFixed(3), r.theoreticalKg.toFixed(3)])).toEqual([
        ['3.500', '14.140'],
        ['6.500', '26.260'],
      ]);
    }
  });

  it('D-574: lo registrado más el borrador no pasa los metros del pedido, y nombra la fila', () => {
    const result = checkDraftRows(state({ reportedMeters: new Decimal('4') }), [
      { coilId: 'c1', pieces: [], meters: '5.000' },
      { coilId: 'c2', pieces: [], meters: '1.001' },
    ]);
    expect(result).toEqual({
      ok: false,
      rowNumber: 2,
      message: 'Excede el plan en 0.001 m · ajusta el plan',
    });
  });

  it('justo los metros del pedido entran', () => {
    const result = checkDraftRows(state({ reportedMeters: new Decimal('4') }), [
      { coilId: 'c1', pieces: [], meters: '6.000' },
    ]);
    expect(result.ok).toBe(true);
  });

  it('sin pedido (a stock) no hay tope de metros, como su parte', () => {
    const result = checkDraftRows(state({ accessory: { orderedMeters: null } }), [
      { coilId: 'c1', pieces: [], meters: '50.000' },
    ]);
    expect(result.ok).toBe(true);
  });

  it('una fila con largos en un accesorio, o sin metros, se rechaza con el texto del parte', () => {
    for (const row of [
      { coilId: 'c1', pieces: [{ lengthMm: '1000.00', qty: 1 }] },
      { coilId: 'c1', pieces: [{ lengthMm: '1000.00', qty: 1 }], meters: '1.000' },
    ]) {
      const result = checkDraftRows(state(), [row]);
      expect(result).toMatchObject({
        ok: false,
        rowNumber: 1,
        message:
          'ACC-050-GRIS es un accesorio: reporta los metros lineales de bobina que usó, no largos',
      });
    }
  });

  it('una fila con metros en una cobertura se rechaza', () => {
    const result = checkDraftRows(state({ accessory: null, planPieces: [] }), [
      { coilId: 'c1', pieces: [], meters: '1.000' },
    ]);
    expect(result).toMatchObject({
      ok: false,
      message: 'ACC-050-GRIS no es un accesorio: detalla los largos que salieron',
    });
  });

  it('los kilos de una bobina se acumulan entre filas también por metros (D-388: la fila 2 sale marcada)', () => {
    const result = checkDraftRows(
      state({
        accessory: { orderedMeters: null },
        coils: [{ coilId: 'c1', coilCode: 'B-1', remainingKg: new Decimal('50'), geometry }],
      }),
      [
        { coilId: 'c1', pieces: [], meters: '10.000' }, // 40.4 kg
        { coilId: 'c1', pieces: [], meters: '10.000' }, // quedan 9.6 kg: fuera de tolerancia
      ],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0]?.outOfTolerance).toBeNull();
      expect(result.rows[1]?.outOfTolerance).not.toBeNull();
      expect(result.rows[1]?.outKg.toFixed(3)).toBe('9.600');
    }
  });

  it('mathPieces: los metros son un solo largo de esa longitud; sin metros, los largos', () => {
    expect(mathPieces({ pieces: [], meters: '3.250' })).toEqual([{ lengthMm: '3250.00', qty: 1 }]);
    const pieces = [{ lengthMm: '4000.00', qty: 2 }];
    expect(mathPieces({ pieces, meters: null })).toEqual(pieces);
  });
});

describe('roofingReportDraftInputSchema (cc41)', () => {
  it('acepta largos o metros, no los dos ni ninguno; las piezas solo con metros', () => {
    expect(
      roofingReportDraftInputSchema.safeParse({ meters: '2.000', piecesCount: 3 }).success,
    ).toBe(true);
    expect(
      roofingReportDraftInputSchema.safeParse({ pieces: [{ lengthMm: '1000.00', qty: 1 }] })
        .success,
    ).toBe(true);
    expect(roofingReportDraftInputSchema.safeParse({}).success).toBe(false);
    expect(
      roofingReportDraftInputSchema.safeParse({
        meters: '2.000',
        pieces: [{ lengthMm: '1000.00', qty: 1 }],
      }).success,
    ).toBe(false);
    expect(
      roofingReportDraftInputSchema.safeParse({
        pieces: [{ lengthMm: '1000.00', qty: 1 }],
        piecesCount: 2,
      }).success,
    ).toBe(false);
  });
});
