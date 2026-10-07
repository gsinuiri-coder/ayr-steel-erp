import type { ReactNode } from 'react';
import { TableCell, TableFooter, TableRow } from '@/components/ui/table';

/**
 * cc31: el pie de una lista — cuántas filas se ven («4 de 38 pedidos en curso») y, bajo la
 * columna de importe, su suma. La suma es la de las filas a la vista (la página), calculada con
 * los valores completos y redondeada al final.
 */
export function ListFooterRow({
  shown,
  total,
  noun,
  colCount,
  amountColumn,
  amount,
}: {
  shown: number;
  total: number;
  /** El nombre en plural y con su filtro: «pedidos en curso». */
  noun: string;
  colCount: number;
  /** Índice (desde 0) de la columna de importe; sin él, el pie solo cuenta. */
  amountColumn?: number;
  amount?: ReactNode;
}) {
  const label =
    shown === total ? `${String(total)} ${noun}` : `${String(shown)} de ${String(total)} ${noun}`;
  if (amountColumn === undefined || amount === undefined) {
    return (
      <TableFooter>
        <TableRow>
          <TableCell colSpan={colCount} className="text-muted-foreground">
            {label}
          </TableCell>
        </TableRow>
      </TableFooter>
    );
  }
  return (
    <TableFooter>
      <TableRow>
        <TableCell colSpan={amountColumn} className="font-normal text-muted-foreground">
          {label}
        </TableCell>
        <TableCell className="text-right font-semibold tabular-nums">{amount}</TableCell>
        {colCount - amountColumn - 1 > 0 && <TableCell colSpan={colCount - amountColumn - 1} />}
      </TableRow>
    </TableFooter>
  );
}
