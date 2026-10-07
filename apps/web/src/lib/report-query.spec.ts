import { describe, expect, it } from 'vitest';
import { keepPreviousInScope, sameScope } from './report-query';

/** cc32 — el dato anterior se conserva solo dentro de la misma pestaña de línea. */
describe('dato anterior mientras carga', () => {
  const scope = ['report', 'sales-margin', 'todas'];
  const placeholder = keepPreviousInScope<{ rows: number }>(scope);
  const previous = { rows: 4 };

  it('al cambiar de periodo en la misma pestaña, conserva el dato anterior', () => {
    expect(
      placeholder(previous, {
        queryKey: ['report', 'sales-margin', 'todas', '2026-09-01', '2026-09-30'],
      }),
    ).toBe(previous);
  });

  it('al cambiar de pestaña de línea, no muestra el dato de otra línea', () => {
    expect(
      placeholder(previous, {
        queryKey: ['report', 'sales-margin', 'drywall', '2026-10-01', '2026-10-07'],
      }),
    ).toBeUndefined();
  });

  it('sin consulta anterior, nada', () => {
    expect(placeholder(undefined, undefined)).toBeUndefined();
  });

  it('el alcance es un prefijo de la clave', () => {
    expect(sameScope(['a', 'b', 'c'], ['a', 'b'])).toBe(true);
    expect(sameScope(['a', 'x', 'c'], ['a', 'b'])).toBe(false);
    expect(sameScope(['a'], ['a', 'b'])).toBe(false);
  });
});
