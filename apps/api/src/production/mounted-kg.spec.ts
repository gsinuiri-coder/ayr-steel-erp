import {
  Decimal,
  mountedKgForReport,
  piecesTheoreticalKg,
  THEORETICAL_KG_TOLERANCE_RATIO,
} from '@ayr/shared';
import { planCoilCloseAdjustment } from '../coils/coil-close-math';
import { checkDraftRows, type DraftCheckState } from './roofing-drafts';
import { reportsOutKg } from './roofing-math';

/**
 * D-246 — el reporte que planta no podía guardar: el teórico pasaba lo montado cuando el acero
 * ya había salido entero.
 *
 * Caso real (2026-09-22): IMPO-ALZ-NATURAL-0.28-4010-11, 1 200 mm × 0.28 mm, densidad 7.85,
 * 4 010 kg montados. 253 planchas × 6.00 m = 1 518 m ⇒ 15.984 kg por plancha con el 1 % de
 * D-165 ⇒ 4 043.952 kg teóricos, 33.952 kg más de lo que el rollo tenía.
 */

const REAL_COIL = 'IMPO-ALZ-NATURAL-0.28-4010-11';
const realGeometry = { widthMm: '1200.00', thicknessMm: '0.28', densityFactor: '7.8500' };
const realPieces = [{ lengthMm: '6000.00', qty: 253 }];

describe('mountedKgForReport (D-246)', () => {
  it('reproduce el teórico del caso real', () => {
    expect(piecesTheoreticalKg(realGeometry, realPieces).toFixed(3)).toBe('4043.952');
  });

  it('caso real: 253 × 6.00 m declarando 4 010 kg PASA y descuenta lo montado', () => {
    const result = mountedKgForReport({
      label: REAL_COIL,
      theoreticalKg: piecesTheoreticalKg(realGeometry, realPieces),
      availableKg: '4010.000',
      declaredKg: '4010.000',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kg.toFixed(3)).toBe('4010.000');
    expect(result.capped).toBe(true);
    expect(result.note).toMatch(/rindió más de lo teórico/);
    expect(result.note).toMatch(/33\.952 kg/);
    expect(result.note).toMatch(/No es un error/);
  });

  it('con lo declarado por debajo de lo montado también pasa, topado en lo montado', () => {
    const result = mountedKgForReport({
      label: REAL_COIL,
      theoreticalKg: '4043.952',
      availableKg: '4010.000',
      declaredKg: '3990.000',
    });
    expect(result).toMatchObject({ ok: true, capped: true });
    if (result.ok) expect(result.kg.toFixed(3)).toBe('4010.000');
  });

  it('lo declarado por encima de lo montado sigue bloqueando', () => {
    const result = mountedKgForReport({
      label: REAL_COIL,
      theoreticalKg: '4043.952',
      availableKg: '4010.000',
      declaredKg: '4020.000',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/monta más material o corrige la cifra/);
  });

  it('sin declarar, un exceso dentro de la tolerancia pasa con aviso', () => {
    // 33.952 kg sobre 4 043.952 kg es el 0.84 %: dentro del 1 %.
    const result = mountedKgForReport({
      label: REAL_COIL,
      theoreticalKg: '4043.952',
      availableKg: '4010.000',
      declaredKg: null,
    });
    expect(result).toMatchObject({ ok: true, capped: true });
    if (result.ok) {
      expect(result.kg.toFixed(3)).toBe('4010.000');
      expect(result.note).not.toBeNull();
    }
  });

  it('sin declarar, el borde exacto de la tolerancia pasa y un gramo más bloquea', () => {
    const theoretical = new Decimal('1000.000');
    const edge = theoretical.minus(theoretical.times(THEORETICAL_KG_TOLERANCE_RATIO)); // 990
    expect(
      mountedKgForReport({
        label: 'B-1',
        theoreticalKg: theoretical,
        availableKg: edge,
        declaredKg: null,
      }).ok,
    ).toBe(true);
    const beyond = mountedKgForReport({
      label: 'B-1',
      theoreticalKg: theoretical,
      availableKg: edge.minus('0.001'),
      declaredKg: null,
    });
    expect(beyond.ok).toBe(false);
    if (!beyond.ok) expect(beyond.message).toMatch(/pasa la tolerancia del 1 %.*declara los kg/);
  });

  it('sin exceso no topa ni avisa: sale el teórico, como siempre', () => {
    const result = mountedKgForReport({
      label: 'B-1',
      theoreticalKg: '500.000',
      availableKg: '4010.000',
      declaredKg: '520.000',
    });
    expect(result).toMatchObject({ ok: true, capped: false, note: null });
    if (result.ok) expect(result.kg.toFixed(3)).toBe('500.000');
  });

  it('una bobina sin kilos montados bloquea aunque se declare', () => {
    expect(
      mountedKgForReport({ label: 'B-1', theoreticalKg: '1', availableKg: '0', declaredKg: '0.5' })
        .ok,
    ).toBe(false);
  });
});

describe('checkDraftRows con el tope de D-246', () => {
  function realState(overrides: Partial<DraftCheckState> = {}): DraftCheckState {
    return {
      orderSeq: 11,
      productSku: 'COB-ALZ-0.28',
      fixedLengthMm: null,
      planPieces: [{ lengthMm: '6000.00', qty: 253 }],
      reportedMeters: new Decimal(0),
      coils: [
        {
          coilId: 'c1',
          coilCode: REAL_COIL,
          remainingKg: new Decimal('4010.000'),
          geometry: realGeometry,
        },
      ],
      ...overrides,
    };
  }

  it('caso real en el borrador: la fila con 4 010 kg declarados pasa y sale por lo montado', () => {
    const result = checkDraftRows(realState(), [
      { coilId: 'c1', pieces: realPieces, consumedKg: '4010.000' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0]?.theoreticalKg.toFixed(3)).toBe('4043.952');
      expect(result.rows[0]?.outKg.toFixed(3)).toBe('4010.000');
    }
  });

  it('una fila topada deja la bobina en cero para la siguiente', () => {
    const result = checkDraftRows(realState({ planPieces: [{ lengthMm: '6000.00', qty: 300 }] }), [
      { coilId: 'c1', pieces: realPieces, consumedKg: '4010.000' },
      { coilId: 'c1', pieces: [{ lengthMm: '6000.00', qty: 1 }], consumedKg: null },
    ]);
    expect(result).toMatchObject({ ok: false, rowNumber: 2 });
    if (!result.ok) expect(result.message).toMatch(/no tiene kilos montados sin rolar/);
  });

  it('el tope de metros del plan (D-146) sigue bloqueando aunque se declaren kilos', () => {
    const result = checkDraftRows(realState({ planPieces: [{ lengthMm: '6000.00', qty: 250 }] }), [
      { coilId: 'c1', pieces: realPieces, consumedKg: '4010.000' },
    ]);
    expect(result).toMatchObject({ ok: false, rowNumber: 1 });
    if (!result.ok) expect(result.message).toMatch(/ajusta primero el plan de corte/);
  });
});

describe('reportsOutKg — el piso del cierre (D-246)', () => {
  it('un reporte de la regla anterior (salida = teórico) da lo mismo que antes', () => {
    const reports = [
      { id: 'r1', theoreticalKg: new Decimal('1200.500') },
      { id: 'r2', theoreticalKg: new Decimal('800.250') },
    ];
    const outs = [
      { refId: 'r1', qty: new Decimal('1200.500') },
      { refId: 'r2', qty: new Decimal('800.250') },
    ];
    const byReport = reportsOutKg(reports, outs);
    const total = reports.reduce((acc, r) => acc.plus(byReport.get(r.id) ?? 0), new Decimal(0));
    const theoretical = reports.reduce((acc, r) => acc.plus(r.theoreticalKg), new Decimal(0));
    expect(total.toFixed(3)).toBe(theoretical.toFixed(3));
  });

  it('un reporte topado cuenta lo que salió, no su teórico', () => {
    const byReport = reportsOutKg(
      [
        { id: 'old', theoreticalKg: new Decimal('100.000') },
        { id: 'capped', theoreticalKg: new Decimal('4043.952') },
      ],
      [
        { refId: 'old', qty: new Decimal('100.000') },
        { refId: 'capped', qty: new Decimal('4010.000') },
      ],
    );
    expect(byReport.get('old')?.toFixed(3)).toBe('100.000');
    expect(byReport.get('capped')?.toFixed(3)).toBe('4010.000');
  });

  it('suma las salidas de un reporte que tocó más de un movimiento, y sin salida cuenta el teórico', () => {
    const byReport = reportsOutKg(
      [
        { id: 'split', theoreticalKg: new Decimal('50.000') },
        { id: 'none', theoreticalKg: new Decimal('20.000') },
      ],
      [
        { refId: 'split', qty: new Decimal('30.000') },
        { refId: 'split', qty: new Decimal('20.000') },
      ],
    );
    expect(byReport.get('split')?.toFixed(3)).toBe('50.000');
    expect(byReport.get('none')?.toFixed(3)).toBe('20.000');
  });
});

describe('cierre de la bobina después de un reporte topado (D-164 + D-246)', () => {
  it('la bobina queda en cero, nunca negativa: cerrarla agotada no liquida nada', () => {
    expect(
      planCoilCloseAdjustment({
        balanceKg: '0.000',
        physicalKg: '0',
        avgCostPen: '0.0000',
        documentUnitCostPen: '4.0000',
      }),
    ).toBeNull();
  });

  it('si al cerrar el rollo todavía tiene acero, entra como SURPLUS al costo del documento', () => {
    const plan = planCoilCloseAdjustment({
      balanceKg: '0.000',
      physicalKg: '12.500',
      avgCostPen: '0.0000',
      documentUnitCostPen: '4.0000',
    });
    expect(plan?.kind).toBe('SURPLUS');
    expect(plan?.qtyKg.toFixed(3)).toBe('12.500');
    expect(plan?.totalCostPen.toFixed(4)).toBe('50.0000');
  });
});
