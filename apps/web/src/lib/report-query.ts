import type { QueryKey } from '@tanstack/react-query';

/**
 * cc32 — el dato anterior de un reporte mientras carga el nuevo.
 *
 * Al cambiar de periodo, la tabla no parpadea: se ve el dato del periodo anterior, marcado como
 * «actualizando» (`isPlaceholderData`). Pero solo dentro del mismo **alcance** —el reporte y su
 * pestaña de línea—: al pasar de Drywall a Servicios, mostrar las filas de Drywall mientras carga
 * sería mostrar otra cosa con el nombre de esta. Fuera del alcance, se espera con el esqueleto.
 *
 * La clave de la consulta empieza por el alcance y sigue con el periodo:
 * `['report', 'sales-margin', 'todas', from, to]` con alcance `['report', 'sales-margin', 'todas']`.
 */
export function sameScope(key: QueryKey, scope: QueryKey): boolean {
  return scope.every((part, i) => key[i] === part);
}

/** `placeholderData` de un reporte: el dato anterior, solo si es del mismo alcance. */
export function keepPreviousInScope<T>(scope: QueryKey) {
  return (
    previous: T | undefined,
    previousQuery: { queryKey: QueryKey } | undefined,
  ): T | undefined =>
    previousQuery !== undefined && sameScope(previousQuery.queryKey, scope) ? previous : undefined;
}
