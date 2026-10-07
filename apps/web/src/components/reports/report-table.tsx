'use client';

import { Fragment, useState, type ReactNode } from 'react';
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
  updating = false,
  filtered,
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
  /** «Total · 4 pedidos», a partir de las filas a la vista. */
  footerLabel: (rows: readonly T[]) => string;
  query: ListQueryState;
  emptyTitle: string;
  emptyHint?: ReactNode;
  noResultsTitle: string;
  onClearSearch?: () => void;
  errorTitle: string;
  rowTestId?: string;
  testId?: string;
  /**
   * Las filas son el dato del periodo anterior mientras carga el nuevo (`isPlaceholderData`): la
   * tabla se atenúa y se anuncia ocupada (`aria-busy`).
   */
  updating?: boolean;
  /**
   * Si hay una búsqueda activa, cuando la vista ya filtró las filas antes de pasarlas (p. ej. para
   * agruparlas). Por defecto, `search` no vacío.
   */
  filtered?: boolean;
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
    <div
      className={cn('rounded-lg border transition-opacity', updating && 'opacity-60')}
      data-testid={testId}
      aria-busy={updating || undefined}
    >
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
            filtered={filtered ?? (search.trim() !== '' && rows.length > 0)}
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
                  <TableRow data-testid={rowTestId}>
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
                  {i === 0 ? footerLabel(visible) : c.total?.(visible)}
                </TableCell>
              ))}
            </TableRow>
          </TableFooter>
        )}
      </Table>
    </div>
  );
}

/**
 * cc32: lo que en un reporte muestra el dato del periodo anterior mientras carga el nuevo (la
 * franja de cifras, las tablas secundarias): atenuado y anunciado como ocupado. La tabla
 * principal lo hace con `ReportTable updating`.
 */
export function BusyRegion({
  busy,
  className,
  children,
  ...rest
}: { busy: boolean } & React.ComponentProps<'div'>) {
  return (
    <div
      {...rest}
      aria-busy={busy || undefined}
      className={cn('transition-opacity', busy && 'opacity-60', className)}
    >
      {children}
    </div>
  );
}

/** La clase de una fila de detalle, igual en todos los reportes. */
export const DETAIL_ROW_CLASSNAME = 'bg-muted/40 text-xs hover:bg-muted/40';
