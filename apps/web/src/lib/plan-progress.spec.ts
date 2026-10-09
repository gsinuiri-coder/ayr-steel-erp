import { describe, expect, it } from 'vitest';
import { Decimal } from '@ayr/shared';
import { planProgress } from './plan-progress';

/** cc38 (D-573, D-575, D-576): la barra de avance de tres tramos y si la orden se puede cerrar. */

const p = (lengthM: number, qty: number) => ({ lengthMm: (lengthM * 1000).toFixed(2), qty });

// Plan del tablero ProducirAvance, simplificado: 6 m × 10, 2.4 m × 10, 1.8 m × 6 = 94.8 m.
const PLAN = [p(6, 10), p(2.4, 10), p(1.8, 6)];

describe('planProgress — tres tramos', () => {
  it('registrado, en borrador y falta suman el plan, con planchas', () => {
    const view = planProgress({
      planMeters: '94.800',
      reportedMeters: '60.000',
      plan: { items: PLAN, remainingPieces: [p(2.4, 10), p(1.8, 6)], reportedPieces: 10 },
      draft: [p(2.4, 4)],
      auto: [],
    });
    expect(view.registered.meters.toFixed(3)).toBe('60.000');
    expect(view.registered.pieces).toBe(10);
    expect(view.draft.meters.toFixed(3)).toBe('9.600');
    expect(view.draft.pieces).toBe(4);
    expect(view.missing.meters.toFixed(3)).toBe('25.200');
    expect(view.missing.pieces).toBe(12);
    expect(view.missingDetail).toEqual([
      { lineNumber: 1, lengthMm: '2400.00', qty: 6 },
      { lineNumber: 2, lengthMm: '1800.00', qty: 6 },
    ]);
    expect(view.plan.pieces).toBe(26);
    expect(view.bar.registered + view.bar.draft).toBeCloseTo((69.6 / 94.8) * 100, 6);
    expect(view.canClose).toBe(false);
    expect(view.toClose.toFixed(3)).toBe('25.200');
  });

  it('sin detalle por largo cuando el borrador trae un largo que no falta (no hay negativos que mostrar)', () => {
    const view = planProgress({
      planMeters: '94.800',
      reportedMeters: '60.000',
      plan: { items: PLAN, remainingPieces: [p(2.4, 10), p(1.8, 6)], reportedPieces: 10 },
      draft: [p(1.8, 8)],
      auto: [],
    });
    expect(view.missingDetail).toBeNull();
    expect(view.missing.pieces).toBeNull();
    expect(view.missing.meters.toFixed(3)).toBe('20.400');
  });

  it('sin detalle si lo registrado usó otros largos (el detalle no daría los metros)', () => {
    // Se registraron 12 m en 4 m × 3 en vez de 6 m × 2: el plan por largo ya no cuadra.
    const view = planProgress({
      planMeters: '94.800',
      reportedMeters: '12.000',
      plan: { items: PLAN, remainingPieces: PLAN, reportedPieces: 3 },
      draft: [],
      auto: [],
    });
    expect(view.missingDetail).toBeNull();
  });
});

describe('planProgress — cerrar (D-573) y el bloque llenado solo (D-575)', () => {
  it('el bloque llenado solo no entra al borrador ni a la barra, pero completa para cerrar con confirmación', () => {
    const view = planProgress({
      planMeters: '94.800',
      reportedMeters: '60.000',
      plan: { items: PLAN, remainingPieces: [p(2.4, 10), p(1.8, 6)], reportedPieces: 10 },
      draft: [],
      auto: [p(2.4, 10), p(1.8, 6)],
    });
    expect(view.draft.meters.isZero()).toBe(true);
    expect(view.missing.meters.toFixed(3)).toBe('34.800');
    expect(view.autoMeters.toFixed(3)).toBe('34.800');
    expect(view.toClose.isZero()).toBe(true);
    expect(view.canClose).toBe(true);
    expect(view.needsAutoConfirm).toBe(true);
  });

  it('con el borrador confirmado completo se cierra sin pedir confirmación', () => {
    const view = planProgress({
      planMeters: '94.800',
      reportedMeters: '60.000',
      plan: { items: PLAN, remainingPieces: [p(2.4, 10), p(1.8, 6)], reportedPieces: 10 },
      draft: [p(2.4, 10), p(1.8, 6)],
      auto: [],
    });
    expect(view.canClose).toBe(true);
    expect(view.needsAutoConfirm).toBe(false);
    expect(view.missing.meters.isZero()).toBe(true);
    expect(view.missingDetail).toEqual([]);
  });

  it('pasarse del plan no se cierra y la barra no pasa del 100 %', () => {
    const view = planProgress({
      planMeters: '94.800',
      reportedMeters: '90.000',
      plan: { items: PLAN, remainingPieces: [p(2.4, 2)], reportedPieces: 24 },
      draft: [p(2.4, 3)],
      auto: [],
    });
    expect(view.excess.toFixed(3)).toBe('2.400');
    expect(view.canClose).toBe(false);
    expect(view.bar.registered + view.bar.draft).toBe(100);
  });

  it('sin nada registrado ni escrito no se cierra', () => {
    const view = planProgress({
      planMeters: '0.000',
      reportedMeters: '0.000',
      plan: { items: [], remainingPieces: [], reportedPieces: 0 },
      draft: [],
      auto: [],
    });
    expect(view.canClose).toBe(false);
  });

  it('accesorio: metros, sin planchas, contra los metros de la orden', () => {
    const view = planProgress({
      planMeters: '20.000',
      reportedMeters: '7.000',
      plan: null,
      draft: new Decimal('5'),
      auto: new Decimal('8'),
    });
    expect(view.registered.pieces).toBeNull();
    expect(view.draft.meters.toFixed(3)).toBe('5.000');
    expect(view.missing.meters.toFixed(3)).toBe('8.000');
    expect(view.missingDetail).toBeNull();
    expect(view.canClose).toBe(true);
    expect(view.needsAutoConfirm).toBe(true);
  });
});
