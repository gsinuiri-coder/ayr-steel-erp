'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TableCell, TableRow } from '@/components/ui/table';

/**
 * cc31: los tres estados de una lista, distintos y con un solo componente.
 *
 * - **Todavía no hay nada**: la lista está vacía de verdad. Dice qué es y, si se puede, cómo
 *   empezar (`empty.action`).
 * - **El filtro no encuentra nada**: hay datos, pero no con estos filtros. Ofrece quitarlos.
 * - **Falló la carga**: no es que no haya; el servidor no respondió. Ofrece reintentar.
 *
 * Antes las tres se veían igual (una línea gris), y una lista que no cargó se leía como una
 * lista vacía.
 */
export interface ListQueryState {
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  refetch: () => unknown;
}

export interface ListStateRowsProps {
  query: ListQueryState;
  colSpan: number;
  /** Filas visibles después de filtrar. */
  isEmpty: boolean;
  /** `true` si hay un filtro o una búsqueda activa. */
  filtered: boolean;
  /** «Todavía no hay despachos». */
  emptyTitle: string;
  /** Qué falta para que aparezca algo, o cómo empezar. */
  emptyHint?: ReactNode;
  emptyAction?: ReactNode;
  /** «Ningún despacho coincide con la búsqueda». */
  noResultsTitle: string;
  noResultsHint?: ReactNode;
  onClearFilters?: () => void;
  /** «No se pudieron cargar los despachos». */
  errorTitle: string;
  skeletonRows?: number;
}

export function ListStateRows({
  query,
  colSpan,
  isEmpty,
  filtered,
  emptyTitle,
  emptyHint,
  emptyAction,
  noResultsTitle,
  noResultsHint,
  onClearFilters,
  errorTitle,
  skeletonRows = 3,
}: ListStateRowsProps) {
  if (query.isPending) {
    return (
      <>
        {Array.from({ length: skeletonRows }, (_, i) => (
          <TableRow key={i}>
            <TableCell colSpan={colSpan}>
              <Skeleton className="h-5 w-full" />
            </TableCell>
          </TableRow>
        ))}
      </>
    );
  }
  if (query.isError) {
    return (
      <StateRow colSpan={colSpan} kind="error">
        <ListStateMessage
          tone="error"
          title={errorTitle}
          hint={
            isEmpty
              ? 'No es que no haya: el servidor no respondió.'
              : 'Lo que ves arriba puede estar desactualizado: el servidor no respondió.'
          }
          action={
            <Button
              size="sm"
              onClick={() => {
                void query.refetch();
              }}
            >
              Reintentar
            </Button>
          }
        />
      </StateRow>
    );
  }
  if (!query.isSuccess || !isEmpty) return null;
  if (filtered) {
    return (
      <StateRow colSpan={colSpan} kind="no-results">
        <ListStateMessage
          title={noResultsTitle}
          hint={noResultsHint}
          action={
            onClearFilters ? (
              <Button size="sm" variant="outline" onClick={onClearFilters}>
                Quitar filtros
              </Button>
            ) : undefined
          }
        />
      </StateRow>
    );
  }
  return (
    <StateRow colSpan={colSpan} kind="empty">
      <ListStateMessage title={emptyTitle} hint={emptyHint} action={emptyAction} />
    </StateRow>
  );
}

function StateRow({
  colSpan,
  kind,
  children,
}: {
  colSpan: number;
  kind: 'empty' | 'no-results' | 'error';
  children: ReactNode;
}) {
  return (
    <TableRow data-list-state={kind} className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="whitespace-normal">
        {children}
      </TableCell>
    </TableRow>
  );
}

/** El bloque centrado de un estado de lista; sirve también fuera de una tabla. */
export function ListStateMessage({
  title,
  hint,
  action,
  tone = 'default',
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  tone?: 'default' | 'error';
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className="flex flex-col items-center gap-2 px-4 py-7 text-center"
    >
      <span className={tone === 'error' ? 'font-semibold text-destructive' : 'font-semibold'}>
        {title}
      </span>
      {hint && <span className="max-w-sm text-muted-foreground">{hint}</span>}
      {action}
    </div>
  );
}
