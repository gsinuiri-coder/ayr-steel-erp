'use client';

import type { ReactNode } from 'react';
import type { KardexSheetRow } from '@ayr/shared';
import { formatDate, formatMoneyOrDash, formatQty } from '@/lib/format';
import { SortableTableHead } from '@/components/sortable-table-head';
import type { SortDir } from '@/lib/use-sort';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * D-298: la tabla del kardex de un ítem **con el formato del cliente**, igual para Promedio y
 * PEPS: Fecha, Detalle, ENTRADAS (cantidad, C.U., monto), SALIDAS y SALDO, con la cabecera de
 * grupo en dos niveles y las cifras en columnas (`tabular-nums`). Solo presenta filas que ya
 * armó `movementsToKardexSheet` / `pepsToKardexSheet`.
 *
 * `renderDetail` deja a quien la usa poner en «Detalle» algo más rico que el texto (el link al
 * documento de origen, la nota y el usuario del movimiento a costo promedio); sin él, el texto.
 */
const NUMERIC = 'px-2 text-right tabular-nums whitespace-nowrap';

const qty = (value: string | null) => (value === null ? '' : formatQty(value));
const unitCost = (value: string | null) =>
  value === null ? '' : formatMoneyOrDash(value, 'PEN', 4);
const amount = (value: string | null) => (value === null ? '' : formatMoneyOrDash(value));

export function KardexSheetTable({
  rows,
  isPending,
  isError,
  emptyMessage,
  dateSort,
  renderDetail,
  rowClassName,
}: {
  rows: readonly KardexSheetRow[];
  isPending: boolean;
  isError: boolean;
  emptyMessage: string;
  /** D-323: la fecha es la única columna que ordena; `dir: null` es el orden en que llegan. */
  dateSort: { dir: SortDir | null; onToggle: () => void };
  renderDetail?: (row: KardexSheetRow) => ReactNode;
  rowClassName?: (row: KardexSheetRow) => string | undefined;
}) {
  const columns = 11;
  const group = 'border-l text-center';
  return (
    <div className="overflow-x-auto" data-testid="kardex-sheet">
      <Table>
        <TableHeader>
          <TableRow>
            <SortableTableHead
              className="align-bottom"
              rowSpan={2}
              active={dateSort.dir !== null}
              dir={dateSort.dir ?? 'asc'}
              onClick={dateSort.onToggle}
            >
              Fecha
            </SortableTableHead>
            <TableHead className="min-w-52 align-bottom">Detalle</TableHead>
            <TableHead colSpan={3} className={group}>
              ENTRADAS
            </TableHead>
            <TableHead colSpan={3} className={group}>
              SALIDAS
            </TableHead>
            <TableHead colSpan={3} className={group}>
              SALDO
            </TableHead>
          </TableRow>
          <TableRow>
            {/* «Fecha» ocupa las dos filas de la cabecera; «Detalle» deja su segunda celda vacía. */}
            <TableHead />
            {[0, 1, 2].flatMap((g) =>
              ['Cantidad', 'C.U.', 'Monto'].map((label, i) => (
                <TableHead
                  key={`${String(g)}-${label}`}
                  className={cn('text-right', i === 0 && 'border-l')}
                >
                  {label}
                </TableHead>
              )),
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isPending && (
            <TableRow>
              <TableCell colSpan={columns} className="text-center text-muted-foreground">
                Cargando…
              </TableCell>
            </TableRow>
          )}
          {isError && (
            <TableRow>
              <TableCell colSpan={columns} className="text-destructive">
                No se pudo cargar el kardex.
              </TableCell>
            </TableRow>
          )}
          {rows.map((row) => (
            <TableRow
              key={row.key}
              className={cn(
                row.kind !== 'movement' && 'bg-muted/30 font-medium',
                rowClassName?.(row),
              )}
            >
              <TableCell className="whitespace-nowrap">
                {row.date ? formatDate(row.date) : ''}
              </TableCell>
              <TableCell className="whitespace-normal">
                {renderDetail ? renderDetail(row) : row.detail}
              </TableCell>
              <TableCell className={cn(NUMERIC, 'border-l')}>{qty(row.inQty)}</TableCell>
              <TableCell className={NUMERIC}>{unitCost(row.inUnitCost)}</TableCell>
              <TableCell className={NUMERIC}>{amount(row.inTotal)}</TableCell>
              <TableCell className={cn(NUMERIC, 'border-l')}>{qty(row.outQty)}</TableCell>
              <TableCell className={NUMERIC}>{unitCost(row.outUnitCost)}</TableCell>
              <TableCell className={NUMERIC}>{amount(row.outTotal)}</TableCell>
              <TableCell className={cn(NUMERIC, 'border-l font-medium')}>
                {qty(row.balanceQty)}
              </TableCell>
              <TableCell className={NUMERIC}>{unitCost(row.balanceUnitCost)}</TableCell>
              <TableCell className={NUMERIC}>{amount(row.balanceTotal)}</TableCell>
            </TableRow>
          ))}
          {!isPending && !isError && rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns} className="text-center text-muted-foreground">
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
