import { SEARCH_MIN_CHARS } from '@ayr/shared';

/** Vacío significa "primeros resultados"; solo 1..mínimo-1 caracteres queda en espera. */
export function belowSearchMinimum(value: string, minChars = SEARCH_MIN_CHARS): boolean {
  const length = value.trim().length;
  return length > 0 && length < minChars;
}

export function asyncSearchStatus({
  belowMinimum,
  isFetching,
  count,
  minChars = SEARCH_MIN_CHARS,
  mayHaveMore = false,
}: {
  belowMinimum: boolean;
  isFetching: boolean;
  count: number;
  minChars?: number;
  mayHaveMore?: boolean;
}): string {
  if (belowMinimum) return `Escribe al menos ${String(minChars)} caracteres para buscar.`;
  if (isFetching) return 'Buscando…';
  return `${String(count)} resultado${count === 1 ? '' : 's'}${
    mayHaveMore ? ' · sigue escribiendo para acotar' : ''
  }`;
}
