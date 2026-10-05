import {
  mountedKgForReport,
  piecesTheoreticalKg,
  THEORETICAL_KG_OVERRIDE_MAX_RATIO,
  THEORETICAL_KG_TOLERANCE_RATIO,
  TOLERANCE_EXCEEDED,
  TOLERANCE_OVERRIDE_REQUIRED,
  toleranceOverrideLabel,
  toleranceOverrideSchema,
} from '@ayr/shared';
import { checkDraftRows, type DraftCheckState } from './roofing-drafts';

/**
 * D-388 — la casilla del administrador para pasar la tolerancia del 1 % en el reporte de
 * coberturas. Tres franjas con la base de siempre (el exceso sobre el teórico, D-246):
 * hasta 1 % como siempre; más de 1 % y hasta 5 % solo con la casilla; más de 5 % nunca.
 */

const ROOFING = (authorized: boolean) => ({ overrideBands: { authorized } });
const report = (theoreticalKg: string, availableKg: string, authorized = false) =>
  mountedKgForReport({
    label: 'BOB-1',
    theoreticalKg,
    availableKg,
    declaredKg: null,
    ...ROOFING(authorized),
  });

describe('las constantes viven en un solo lugar', () => {
  it('1 % y 5 %', () => {
    expect(THEORETICAL_KG_TOLERANCE_RATIO).toBe('0.01');
    expect(THEORETICAL_KG_OVERRIDE_MAX_RATIO).toBe('0.05');
  });
});

describe('mountedKgForReport — las tres franjas (sale más de lo montado)', () => {
  it('hasta 1 %, exacto: entra sin casilla y se topa en lo montado', () => {
    const r = report('1000', '990');
    expect(r).toMatchObject({ ok: true, capped: true, overridden: false, excess: null });
    expect(r.ok && r.kg.toFixed(3)).toBe('990.000');
  });

  it('apenas más de 1 %: sin casilla, el rechazo trae su código y las cifras', () => {
    const r = report('1000', '989.9');
    expect(r).toMatchObject({
      ok: false,
      code: TOLERANCE_OVERRIDE_REQUIRED,
      excess: {
        theoreticalKg: '1000.000',
        availableKg: '989.900',
        excessKg: '10.100',
        excessPct: '1.01',
        tolerancePct: '1',
        maxPct: '5',
      },
    });
    expect(!r.ok && r.message).toContain('lo autoriza un administrador');
  });

  it('apenas más de 1 %: con casilla entra, con el consumo topado en lo montado', () => {
    const r = report('1000', '989.9', true);
    expect(r).toMatchObject({ ok: true, capped: true, overridden: true });
    expect(r.ok && r.kg.toFixed(3)).toBe('989.900');
    expect(r.ok && r.excess?.excessPct).toBe('1.01');
  });

  it('5 % exacto: todavía se puede autorizar', () => {
    expect(report('1000', '950')).toMatchObject({ ok: false, code: TOLERANCE_OVERRIDE_REQUIRED });
    expect(report('1000', '950', true)).toMatchObject({ ok: true, overridden: true });
  });

  it('más de 5 %: bloqueado siempre, aunque venga la casilla', () => {
    for (const authorized of [false, true]) {
      const r = report('1000', '949.9', authorized);
      expect(r).toMatchObject({ ok: false, code: TOLERANCE_EXCEEDED });
      expect(!r.ok && r.message).toContain('Revisa la cantidad, el largo o la bobina');
    }
  });

  it('sin material montado no hay franja: monta más material', () => {
    expect(report('100', '0', true)).toMatchObject({ ok: false });
    expect(report('100', '0', true)).not.toHaveProperty('code');
  });

  it('con kilos declarados que caben en lo montado, la casilla los respeta', () => {
    const r = mountedKgForReport({
      label: 'BOB-1',
      theoreticalKg: '1000',
      availableKg: '980',
      declaredKg: '975',
      ...ROOFING(true),
    });
    expect(r).toMatchObject({ ok: true, overridden: true });
    expect(r.ok && r.kg.toFixed(3)).toBe('980.000');
  });
});

describe('sale menos de lo montado: la regla no cambia (decisión del dueño)', () => {
  it.each(['1', '3', '10', '50'])(
    '%s %% menos que lo montado: sale el teórico, sin casilla',
    (pct) => {
      const available = (1000 * (1 + Number(pct) / 100)).toFixed(3);
      const r = report('1000', available);
      expect(r).toMatchObject({ ok: true, capped: false, overridden: false });
      expect(r.ok && r.kg.toFixed(3)).toBe('1000.000');
    },
  );
});

describe('drywall (sin franjas): igual que antes de D-388', () => {
  it('pasado el 1 % se rechaza con el mensaje de siempre, sin código ni casilla', () => {
    const r = mountedKgForReport({
      label: 'OP-000001',
      theoreticalKg: '1000',
      availableKg: '980',
      declaredKg: null,
    });
    expect(r).toMatchObject({ ok: false });
    expect(r).not.toHaveProperty('code');
    expect(!r.ok && r.message).toContain('pasa la tolerancia del 1 % del teórico');
  });
});

describe('el caso real: XSY-ALZ-ROJO-3020-0.28-4184-10', () => {
  // 428 planchas de 3,60 m = 1 540,8 m; con 1 220 mm × 0,28 mm y densidad 8 (× 1,01 de la merma
  // estándar) son 2,7601 kg/m, el mismo kilo por metro del caso.
  const geometry = { widthMm: '1220', thicknessMm: '0.28', densityFactor: '8.0000' };
  const theoretical = piecesTheoreticalKg(geometry, [{ lengthMm: '3600', qty: 428 }]);

  it('el teórico y la diferencia son los del caso', () => {
    expect(theoretical.toFixed(3)).toBe('4252.805');
  });

  it('sin casilla se bloquea; con casilla consume los 4 184 kg montados y deja la bobina en 0', () => {
    expect(report(theoretical.toFixed(3), '4184')).toMatchObject({
      ok: false,
      code: TOLERANCE_OVERRIDE_REQUIRED,
      excess: { excessKg: '68.805', excessPct: '1.62' },
    });
    const r = report(theoretical.toFixed(3), '4184', true);
    expect(r).toMatchObject({ ok: true, overridden: true });
    expect(r.ok && r.kg.toFixed(3)).toBe('4184.000');
  });

  it('el borrador acepta la fila y la marca «fuera de tolerancia»; el teórico no se toca', () => {
    const state: DraftCheckState = {
      orderSeq: 1,
      productSku: 'COB-ROJO-028',
      fixedLengthMm: '3600.00',
      planPieces: [{ lengthMm: '3600', qty: 428 }],
      reportedMeters: theoretical.minus(theoretical),
      coils: [
        {
          coilId: 'c-1',
          coilCode: 'XSY-ALZ-ROJO-3020-0.28-4184-10',
          remainingKg: theoretical.minus(theoretical).plus('4184'),
          geometry,
        },
      ],
    };
    const result = checkDraftRows(state, [
      { coilId: 'c-1', pieces: [{ lengthMm: '3600', qty: 428 }] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]?.outKg.toFixed(3)).toBe('4184.000');
    expect(result.rows[0]?.outOfTolerance).toMatchObject({ excessKg: '68.805', excessPct: '1.62' });
  });

  it('el borrador rechaza la fila de más del 5 % al ingresarla', () => {
    const state: DraftCheckState = {
      orderSeq: 1,
      productSku: 'COB-ROJO-028',
      fixedLengthMm: '3600.00',
      planPieces: [{ lengthMm: '3600', qty: 445 }],
      reportedMeters: theoretical.minus(theoretical),
      coils: [
        {
          coilId: 'c-1',
          coilCode: 'XSY-ALZ-ROJO-3020-0.28-4184-10',
          remainingKg: theoretical.minus(theoretical).plus('4184'),
          geometry,
        },
      ],
    };
    const result = checkDraftRows(state, [
      { coilId: 'c-1', pieces: [{ lengthMm: '3600', qty: 445 }] },
    ]);
    expect(result).toMatchObject({ ok: false, rowNumber: 1 });
    expect(!result.ok && result.message).toContain('Revisa la cantidad, el largo o la bobina');
  });
});

describe('el motivo', () => {
  it.each([
    [{ reason: 'LIGHTER_COIL' }, true],
    [{ reason: 'HEAVIER_COIL', detail: 'pesó 4 184 en balanza' }, true],
    [{ reason: 'OTHER', detail: 'Rollo de prueba del proveedor' }, true],
    [{ reason: 'OTHER' }, false],
    [{ reason: 'OTHER', detail: '   ' }, false],
    [{ reason: 'CUALQUIERA' }, false],
    [{}, false],
  ])('%j → válido: %s', (input, valid) => {
    expect(toleranceOverrideSchema.safeParse(input).success).toBe(valid);
  });

  it('en palabras', () => {
    expect(toleranceOverrideLabel({ reason: 'LIGHTER_COIL' })).toBe(
      'Bobina más liviana que el nominal',
    );
    expect(toleranceOverrideLabel({ reason: 'HEAVIER_COIL', detail: 'pesó 4 184' })).toBe(
      'Bobina más pesada que el nominal: pesó 4 184',
    );
    expect(toleranceOverrideLabel({ reason: 'OTHER', detail: 'Rollo de prueba' })).toBe(
      'Rollo de prueba',
    );
  });
});

describe('reportInTx — la casilla es solo del administrador (D-388)', () => {
  it('un no administrador con casilla recibe 403 antes de tocar la base', async () => {
    const { RoofingProductionService } = await import('./roofing-production.service');
    const { ForbiddenException } = await import('@nestjs/common');
    const svc = Object.create(RoofingProductionService.prototype) as InstanceType<
      typeof RoofingProductionService
    >;
    const tx = new Proxy(
      {},
      {
        get: () => {
          throw new Error('no debía tocar la base');
        },
      },
    );
    for (const role of ['SUPERVISOR_PLANTA', 'VENDEDOR'] as const) {
      await expect(
        svc.reportInTx(
          tx as never,
          { id: 'u-1', role } as never,
          'op-1',
          {
            pieces: [{ lengthMm: '3600', qty: 428 }],
            toleranceOverride: { reason: 'LIGHTER_COIL' },
          } as never,
          '2026-10-05',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
});

describe('el porcentaje que se muestra', () => {
  it('se redondea hacia arriba: lo que pasó el 1 % o el 5 % nunca dice «1.00 %» ni «5.00 %»', () => {
    expect(report('1000', '989.99')).toMatchObject({ excess: { excessPct: '1.01' } });
    expect(report('1000', '949.97', true)).toMatchObject({
      code: TOLERANCE_EXCEEDED,
      excess: { excessPct: '5.01' },
    });
  });
});
