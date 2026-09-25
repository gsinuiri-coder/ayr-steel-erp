'use client';

import { ChevronDown, ChevronsUpDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TableHead } from '@/components/ui/table';
import type { SortDir, SortState } from '@/lib/use-sort';

/**
 * S10b/M1: encabezado de columna clickeable. El ícono dice el estado — `ChevronsUpDown`
 * gris cuando esta columna no es la que ordena, la flecha llena cuando sí — sin agregar
 * un texto "ordenar por" a cada columna, que en una tabla de siete columnas ya es angosta.
 *
 * D-323: los filtros por columna de D-295 se retiraron —el cliente pidió solo reordenar—. Sin
 * `onClick` el encabezado no ordena: es un rótulo. `title` sirve para decir que el orden es solo
 * de las filas de la página (una columna derivada de un listado paginado).
 */
export function SortableTableHead({
  active = false,
  dir = 'asc',
  align = 'left',
  className,
  onClick,
  title,
  rowSpan,
  children,
}: {
  active?: boolean;
  dir?: SortDir;
  align?: 'left' | 'right';
  className?: string;
  onClick?: () => void;
  title?: string;
  rowSpan?: number;
  children: React.ReactNode;
}) {
  const Icon = active ? (dir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <TableHead
      className={className}
      rowSpan={rowSpan}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      {onClick ? (
        <button
          type="button"
          title={title}
          onClick={onClick}
          className={cn(
            'inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
            align === 'right' && 'flex-row-reverse',
            !active && 'text-muted-foreground',
          )}
        >
          <span>{children}</span>
          <Icon className="size-3.5 shrink-0" aria-hidden />
        </button>
      ) : (
        <span>{children}</span>
      )}
    </TableHead>
  );
}

/**
 * D-323: el encabezado ordenable de una tabla, con el estado de `useSort` ya cableado:
 * `<SortHead sort={sort} onSort={toggleSort} k="name">Nombre</SortHead>`.
 */
export function SortHead<K extends string>({
  sort,
  onSort,
  k,
  ...rest
}: {
  sort: SortState<K>;
  onSort: (key: K) => void;
  k: K;
  align?: 'left' | 'right';
  className?: string;
  title?: string;
  rowSpan?: number;
  children: React.ReactNode;
}) {
  return (
    <SortableTableHead
      {...rest}
      active={sort.key === k}
      dir={sort.dir}
      onClick={() => {
        onSort(k);
      }}
    />
  );
}
