import { useState } from 'react';

/**
 * D-295: filtros de texto por columna, **en el cliente**, para las tablas que no paginan
 * (catálogo, kardex de un ítem, órdenes del pedido, historial de órdenes): la lista ya está
 * entera en el navegador, así que filtrar por columna es exacto. Tiene la forma del
 * `columnFilters` de TanStack Table (`id → valor`), sin arrastrar la tabla completa.
 *
 * En una tabla paginada por el servidor un filtro de columna en el cliente solo filtraría la
 * página que se ve y confundiría —«no hay nada» cuando en la página siguiente sí—; esas listas
 * filtran en el servidor por cliente, estado y rango de fechas (D-289) y no usan esto.
 */
export type ColumnFilters<K extends string> = Partial<Record<K, string>>;

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Deja las filas cuyo texto de cada columna filtrada contiene lo escrito (sin mayúsculas ni acentos). */
export function filterRows<T, K extends string>(
  rows: readonly T[],
  filters: ColumnFilters<K>,
  accessors: Record<K, (row: T) => string>,
): T[] {
  const active = (Object.entries(filters) as [K, string | undefined][]).filter(
    ([, value]) => normalize(value ?? '') !== '',
  );
  if (active.length === 0) return [...rows];
  return rows.filter((row) =>
    active.every(([key, value]) => normalize(accessors[key](row)).includes(normalize(value ?? ''))),
  );
}

export function useColumnFilters<K extends string>() {
  const [filters, setFilters] = useState<ColumnFilters<K>>({});
  return {
    filters,
    setFilter: (key: K, value: string) => {
      setFilters((current) => ({ ...current, [key]: value }));
    },
    apply: <T>(rows: readonly T[], accessors: Record<K, (row: T) => string>): T[] =>
      filterRows(rows, filters, accessors),
    hasActive: Object.values(filters).some(
      (v) => normalize((v as string | undefined) ?? '') !== '',
    ),
    clear: () => {
      setFilters({});
    },
  };
}
