import { defaultRoofingPlan, MAX_PIECE_LENGTH_MM, piecesMeters } from '@ayr/shared';

/**
 * Lo que el importador de cotizaciones decide **sin base de datos** (D-152): el plan de corte
 * por defecto. Es la única aritmética de la puerta nueva, y es justo donde el dueño eligió que
 * el importador **falle en vez de inventar**.
 */
describe('defaultRoofingPlan (D-152)', () => {
  it('una línea que entra en una plancha se convierte en 1 × sus metros', () => {
    const plan = defaultRoofingPlan('12.500');
    expect(plan.ok).toBe(true);
    if (plan.ok !== true) return;
    expect(plan.pieces).toEqual([{ lengthMm: '12500.00', qty: 1 }]);
    // Y los metros del plan son los de la línea: es la invariante que el alta vuelve a exigir.
    expect(piecesMeters(plan.pieces).toFixed(3)).toBe('12.500');
  });

  it('el borde exacto de una plancha entra', () => {
    const plan = defaultRoofingPlan(String(MAX_PIECE_LENGTH_MM / 1000));
    expect(plan.ok).toBe(true);
  });

  it('un metro más que el tope ya no: el plan se escribe a mano', () => {
    // El caso real del archivo de agosto: 23 de las 27 líneas en metro lineal se pasan, y una
    // llega a 1 832 m. Repartirlas en planchas de 6 m habría escrito en el plan de corte —que
    // después es el tope duro de lo que planta puede reportar (D-146)— un dato que el Excel no
    // dice en ninguna parte.
    const plan = defaultRoofingPlan('81.900');
    expect(plan.ok).toBe(false);
    if (plan.ok !== false) return;
    expect(plan.reason).toContain('1 × 81.90 m');
    expect(plan.reason).toContain('escribe el plan de corte real');
  });

  it('una cantidad en cero o negativa no deriva ningún plan', () => {
    expect(defaultRoofingPlan('0').ok).toBe(false);
    expect(defaultRoofingPlan('-3').ok).toBe(false);
  });

  it('un largo por debajo del mínimo tampoco: eso es un recorte, no una plancha', () => {
    const plan = defaultRoofingPlan('0.05');
    expect(plan.ok).toBe(false);
    if (plan.ok !== false) return;
    expect(plan.reason).toContain('no baja de');
  });
});
