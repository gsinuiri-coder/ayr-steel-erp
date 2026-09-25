'use client';

import { ChevronDown, ChevronsUpDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { TableHead } from '@/components/ui/table';
import type { SortDir } from '@/lib/use-sort';

/**
 * S10b/M1: encabezado de columna clickeable. El ícono dice el estado — `ChevronsUpDown`
 * gris cuando esta columna no es la que ordena, la flecha llena cuando sí — sin agregar
 * un texto "ordenar por" a cada columna, que en una tabla de siete columnas ya es angosta.
 *
 * D-295: además puede llevar un **filtro de texto** de la columna (`filter`), debajo del
 * rótulo, solo para tablas que no paginan (ver `useColumnFilters`). Sin `onClick` el
 * encabezado no ordena: es un rótulo con su filtro.
 */
export function SortableTableHead({
  active = false,
  dir = 'asc',
  align = 'left',
  className,
  onClick,
  filter,
  children,
}: {
  active?: boolean;
  dir?: SortDir;
  align?: 'left' | 'right';
  className?: string;
  onClick?: () => void;
  filter?: { value: string; onChange: (value: string) => void; label: string };
  children: React.ReactNode;
}) {
  const Icon = active ? (dir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <TableHead className={cn(filter && 'h-auto py-1', className)}>
      {onClick ? (
        <button
          type="button"
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
      {filter && (
        <Input
          aria-label={`Filtrar por ${filter.label}`}
          placeholder="Filtrar…"
          className="mt-1 h-6 min-w-16 px-1.5 text-xs font-normal md:text-xs"
          value={filter.value}
          onChange={(e) => {
            filter.onChange(e.target.value);
          }}
        />
      )}
    </TableHead>
  );
}
