import { describe, expect, it } from 'vitest';
import { asyncSearchStatus, belowSearchMinimum } from './search-status';

describe('estado de búsqueda server-side (RF-S3)', () => {
  it('distingue la carga inicial vacía de una búsqueda todavía demasiado corta', () => {
    expect(belowSearchMinimum('')).toBe(false);
    expect(belowSearchMinimum('  ')).toBe(false);
    expect(belowSearchMinimum('a')).toBe(true);
    expect(belowSearchMinimum('ab')).toBe(false);
  });

  it('explica el mínimo antes de mostrar el estado de red', () => {
    expect(asyncSearchStatus({ belowMinimum: true, isFetching: true, count: 0, minChars: 3 })).toBe(
      'Escribe al menos 3 caracteres para buscar.',
    );
  });

  it('muestra carga, singular, plural y la advertencia de tope', () => {
    expect(asyncSearchStatus({ belowMinimum: false, isFetching: true, count: 0 })).toBe(
      'Buscando…',
    );
    expect(asyncSearchStatus({ belowMinimum: false, isFetching: false, count: 1 })).toBe(
      '1 resultado',
    );
    expect(
      asyncSearchStatus({
        belowMinimum: false,
        isFetching: false,
        count: 20,
        mayHaveMore: true,
      }),
    ).toBe('20 resultados · sigue escribiendo para acotar');
  });
});
