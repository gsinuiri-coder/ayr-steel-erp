'use client';

import { ChevronDown, ChevronsUpDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TableHead } from '@/components/ui/table';
import type { SortDir } from '@/lib/use-sort';

/**
 * S10b/M1: encabezado de columna clickeable. El ícono dice el estado — `ChevronsUpDown`
 * gris cuando esta columna no es la que ordena, la flecha llena cuando sí — sin agregar
 * un texto "ordenar por" a cada columna, que en una tabla de siete columnas ya es angosta.
 */
export function SortableTableHead({
  active,
  dir,
  align = 'left',
  className,
  onClick,
  children,
}: {
  active: boolean;
  dir: SortDir;
  align?: 'left' | 'right';
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const Icon = active ? (dir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <TableHead className={className}>
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
    </TableHead>
  );
}
