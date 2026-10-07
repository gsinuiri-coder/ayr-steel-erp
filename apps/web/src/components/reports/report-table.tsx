'use client';

import { Fragment, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { ListStateRows, type ListQueryState } from '@/components/list-state';
import { SortHead } from '@/components/sortable-table-head';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { visibleReportRows, type ReportTableLogic } from '@/lib/report-table';
import type { SortState } from '@/lib/use-sort';
import { cn } from '@/lib/utils';

/**
 * cc32: una columna de la tabla de un reporte. La unidad va en el encabezado («Venta (S/)»), no
 * en cada celda.
 */
export interface ReportColumn<T> extends ReportTableLogic<T> {
  header: string;
  align?: 'left' | 'right';
  /** Clase de la celda y del encabezado (p. ej. ocultarla en pantallas angostas). */
  className?: string;
  cell: (row: T) => ReactNode;
  /** El pie de la columna, calculado sobre las filas a la vista (búsqueda aplicada). */
  total?: (rows: readonly T[]) => ReactNode;
}

/**
 * cc32: la tabla de un reporte, igual en todos: orden por cualquier columna (en la URL), búsqueda
 * sobre lo cargado, detalle de la fila con chevron y fila de total al pie. Las filas ya llegaron
 * enteras del API: ordenar, buscar y sumar se hace acá, sin pedir nada nuevo.
 */
export function ReportTable<T>({
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  search,
  detail,
  detailLabel,
  footerLabel,
  query,
  emptyTitle,
  emptyHint,
  noResultsTitle,
  onClearSearch,
  errorTitle,
  rowTestId,
  testId,
  onRowActivate,
  rowTitle,
}: {
  columns: readonly ReportColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  sort: SortState<string>;
  onSort: (key: string) => void;
  search: string;
  /** Las filas de detalle de una fila (alineadas con las columnas); sin él, no hay chevron. */
  detail?: (row: T) => ReactNode;
  /** Qué fila abre el chevron, para el lector de pantalla («PED-000061»). */
  detailLabel?: (row: T) => string;
  /** «Total · 4 pedidos». */
  footerLabel: (count: number) => string;
  query: ListQueryState;
  emptyTitle: string;
  emptyHint?: ReactNode;
  noResultsTitle: string;
  onClearSearch?: () => void;
  errorTitle: string;
  rowTestId?: string;
  testId?: string;
  /**
   * cc32 (corte 2): la fila entera abre algo (el diálogo de Ventas por material, D-370), con
   * clic, Enter o espacio. Sin él, la fila no es interactiva.
   */
  onRowActivate?: (row: T) => void;
  /** El aviso nativo de la fila interactiva («Ver el desglose…»). */
  rowTitle?: string;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const visible = visibleReportRows(rows, columns, search, sort);
  const toggle = (key: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const alignClass = (c: ReportColumn<T>) => (c.align === 'right' ? 'text-right' : undefined);

  return (
    <div className="rounded-lg border" data-testid={testId}>
      <Table list>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            {columns.map((c) =>
              c.sortValue ? (
                <SortHead
                  key={c.key}
                  sort={sort}
                  onSort={onSort}
                  k={c.key}
                  align={c.align}
                  className={cn(alignClass(c), c.className)}
                >
                  {c.header}
                </SortHead>
              ) : (
                <TableHead key={c.key} className={cn(alignClass(c), c.className)}>
                  {c.header}
                </TableHead>
              ),
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          <ListStateRows
            query={query}
            colSpan={columns.length}
            isEmpty={visible.length === 0}
            filtered={search.trim() !== '' && rows.length > 0}
            emptyTitle={emptyTitle}
            emptyHint={emptyHint}
            noResultsTitle={noResultsTitle}
            onClearFilters={onClearSearch}
            errorTitle={errorTitle}
          />
          {!query.isPending &&
            visible.map((row) => {
              const key = rowKey(row);
              const expanded = open.has(key);
              return (
                <Fragment key={key}>
                  <TableRow
                    data-testid={rowTestId}
                    {...(onRowActivate && {
                      className: 'cursor-pointer hover:bg-muted/50',
                      tabIndex: 0,
                      title: rowTitle,
                      onClick: () => {
                        onRowActivate(row);
                      },
                      onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onRowActivate(row);
                        }
                      },
                    })}
                  >
                    {columns.map((c, i) => (
                      <TableCell key={c.key} className={cn(alignClass(c), c.className)}>
                        {i === 0 && detail ? (
                          <span className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              aria-expanded={expanded}
                              aria-label={`${expanded ? 'Ocultar' : 'Ver'} detalle de ${detailLabel?.(row) ?? key}`}
                              className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                              onClick={() => {
                                toggle(key);
                              }}
                            >
                              {expanded ? (
                                <ChevronDown className="size-4" aria-hidden />
                              ) : (
                                <ChevronRight className="size-4" aria-hidden />
                              )}
                            </button>
                            {c.cell(row)}
                          </span>
                        ) : (
                          c.cell(row)
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                  {expanded && detail?.(row)}
                </Fragment>
              );
            })}
        </TableBody>
        {!query.isPending && visible.length > 0 && (
          <TableFooter data-testid={testId ? `${testId}-total` : undefined}>
            <TableRow>
              {columns.map((c, i) => (
                <TableCell
                  key={c.key}
                  data-column={c.key}
                  className={cn(
                    alignClass(c),
                    c.className,
                    i === 0 ? 'font-normal text-muted-foreground' : 'font-semibold',
                  )}
                >
                  {i === 0 ? footerLabel(visible.length) : c.total?.(visible)}
                </TableCell>
              ))}
            </TableRow>
          </TableFooter>
        )}
      </Table>
    </div>
  );
}

/** La clase de una fila de detalle, igual en todos los reportes. */
export const DETAIL_ROW_CLASSNAME = 'bg-muted/40 text-xs hover:bg-muted/40';
