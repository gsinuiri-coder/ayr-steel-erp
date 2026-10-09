import { checkRoofingPlanAdjustment, reportedPlanPieces, type PieceLike } from '@ayr/shared';

/**
 * cc35 (ESPEC §3, D-545/D-546): ajustar el plan de corte. El total tiene que dar los mismos metros
 * del plan vigente (a medida) y ningún largo baja de las planchas que ya se reportaron.
 */
const p = (lengthM: string, qty: number): PieceLike => ({
  lengthMm: (Number(lengthM) * 1000).toFixed(2),
  qty,
});

const current = [p('6.00', 10), p('5.20', 8), p('2.40', 14)]; // 60 + 41.6 + 33.6 = 135.2 m

describe('checkRoofingPlanAdjustment', () => {
  it('acepta un plan que reparte los mismos metros de otra forma', () => {
    // 2.40 × 14 = 33.6 m → 2.40 × 8 (19.2) + 1.80 × 8 (14.4)
    const next = [p('6.00', 10), p('5.20', 8), p('2.40', 8), p('1.80', 8)];
    const check = checkRoofingPlanAdjustment({ current, next, reported: [], exactMeters: true });
    expect(check.ok).toBe(true);
    expect(check.planMeters.toFixed(3)).toBe('135.200');
  });

  it('rechaza un plan a medida que suma más metros, y dice cuánto sobra', () => {
    const next = [p('6.00', 10), p('5.20', 8), p('2.40', 8), p('1.80', 9)];
    const check = checkRoofingPlanAdjustment({ current, next, reported: [], exactMeters: true });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.kind).toBe('meters');
    expect(check.message).toMatch(/suma 137\.000 m y el original 135\.200 m: sobran 1\.800 m/);
  });

  it('rechaza un plan a medida que suma menos metros, y dice cuánto falta', () => {
    const next = [p('6.00', 10), p('5.20', 8), p('2.40', 13)];
    const check = checkRoofingPlanAdjustment({ current, next, reported: [], exactMeters: true });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.message).toMatch(/faltan 2\.400 m/);
  });

  it('sin `exactMeters` (plancha de catálogo) el total puede cambiar', () => {
    const plancha = [p('3.05', 40)];
    const check = checkRoofingPlanAdjustment({
      current: plancha,
      next: [p('3.05', 44)],
      reported: [],
      exactMeters: false,
    });
    expect(check.ok).toBe(true);
  });

  it('un plan vigente vacío no tiene metros que respetar', () => {
    const check = checkRoofingPlanAdjustment({
      current: [],
      next: [p('4.00', 5)],
      reported: [],
      exactMeters: true,
    });
    expect(check.ok).toBe(true);
  });

  it('un largo no baja de las planchas ya reportadas', () => {
    const reported = [p('5.20', 3)];
    const next = [p('6.00', 10), p('5.20', 2), p('2.40', 14), p('1.00', 6)];
    const check = checkRoofingPlanAdjustment({ current, next, reported, exactMeters: true });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.kind).toBe('reported');
    expect(check.message).toMatch(/5\.20 m ya tiene 3 planchas reportadas: no puede quedar con 2/);
  });

  it('un largo con planchas reportadas no se quita, aunque el total cuadre', () => {
    const reported = [p('6.00', 1)];
    const next = [p('5.20', 8), p('2.40', 14), p('4.00', 15)];
    const check = checkRoofingPlanAdjustment({ current, next, reported, exactMeters: false });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.message).toMatch(/6\.00 m ya tiene 1 plancha reportada: no se puede quitar/);
  });

  it('un largo reportado que el plan no tiene no pone piso', () => {
    const reported = [p('7.00', 2)];
    const next = [p('6.00', 10), p('5.20', 8), p('2.40', 8), p('1.80', 8)];
    expect(checkRoofingPlanAdjustment({ current, next, reported, exactMeters: true }).ok).toBe(
      true,
    );
  });
});

describe('reportedPlanPieces', () => {
  it('dice cuántas planchas de cada línea del plan ya salieron, topado por la línea', () => {
    expect(reportedPlanPieces(current, [p('6.00', 12), p('2.40', 4), p('9.00', 1)])).toEqual([
      10, 0, 4,
    ]);
  });
});
