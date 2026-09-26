'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  BUSINESS_LINES,
  Decimal,
  Role,
  type BusinessLine,
  type StripStockRowDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatMoneyOrDash, formatQty } from '@/lib/format';
import { RoleGate } from '@/components/role-gate';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { SortHead } from '@/components/sortable-table-head';
import { sortRows } from '@/lib/sort-rows';
import { useSort } from '@/lib/use-sort';

const ALL = 'ALL';

/** Stock de flejes por ancho (RF-42): a diferencia de `/inventario`, agrupa por tipo Y ancho. */
export function FlejesView() {
  // D-323: la tabla muestra su lista entera; el orden por columna es sobre todas las filas.
  const [sort, toggleSort] = useSort<
    'finish' | 'thickness' | 'width' | 'qty' | 'cost' | 'value' | 'coils'
  >();
  const [businessLine, setBusinessLine] = useState<BusinessLine | typeof ALL>(ALL);

  const queryString = businessLine !== ALL ? `?businessLine=${businessLine}` : '';
  const stock = useQuery({
    queryKey: ['cutting', 'strips', businessLine],
    queryFn: () => api<StripStockRowDto[]>(`/cutting/strips${queryString}`),
  });

  // D-003: dinero nunca se opera con `number`.
  const totalPen = (stock.data ?? []).reduce(
    (acc, r) => (r.totalValuePen ? acc.plus(new Decimal(r.totalValuePen)) : acc),
    new Decimal(0),
  );

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA, Role.VENDEDOR]}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Flejes</h1>
          <p className="text-xs text-muted-foreground">
            Stock de flejes agrupado por acabado, espesor y ancho (RF-42). Nacen del partido interno
            (RF-15) o de la recepción de corte tercerizado (RF-41).
          </p>
        </div>
        <Select
          value={businessLine}
          onValueChange={(v) => {
            setBusinessLine(v as BusinessLine | typeof ALL);
          }}
        >
          <SelectTrigger className="w-52" aria-label="Línea de negocio">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todas las líneas</SelectItem>
            {BUSINESS_LINES.map((line) => (
              <SelectItem key={line} value={line}>
                {BUSINESS_LINE_LABELS[line]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <SortHead sort={sort} onSort={toggleSort} k="finish">
                Acabado
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="thickness"
                className="text-right"
                align="right"
              >
                Espesor
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="width"
                className="text-right"
                align="right"
              >
                Ancho
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="qty"
                className="text-right"
                align="right"
              >
                Stock
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="cost"
                className="text-right"
                align="right"
              >
                Costo/kg
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="value"
                className="text-right"
                align="right"
              >
                Valorizado
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="coils"
                className="text-right"
                align="right"
              >
                Bobinas
              </SortHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stock.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {stock.isError && (
              <TableRow>
                <TableCell colSpan={7} className="text-destructive">
                  No se pudo cargar el stock de flejes.
                </TableCell>
              </TableRow>
            )}
            {sortRows(stock.data ?? [], sort, {
              finish: { text: (r) => r.finishCode },
              thickness: { decimal: (r) => r.thicknessMm },
              width: { decimal: (r) => r.widthMm },
              qty: { decimal: (r) => r.qtyKg },
              cost: { decimal: (r) => r.avgCostPen ?? '' },
              value: { decimal: (r) => r.totalValuePen ?? '' },
              coils: { decimal: (r) => String(r.coilCount) },
            }).map((r) => (
              <TableRow key={`${r.typeKey}-${r.widthMm}`}>
                <TableCell className="font-medium">{r.finishCode}</TableCell>
                <TableCell className="text-right">{r.thicknessMm} mm</TableCell>
                <TableCell className="text-right">{r.widthMm} mm</TableCell>
                <TableCell className="text-right font-medium">{formatQty(r.qtyKg, 'kg')}</TableCell>
                <TableCell className="text-right">
                  {formatMoneyOrDash(r.avgCostPen, 'PEN', 4)}
                </TableCell>
                <TableCell className="text-right">{formatMoneyOrDash(r.totalValuePen)}</TableCell>
                <TableCell className="text-right">{r.coilCount}</TableCell>
              </TableRow>
            ))}
            {stock.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  No hay flejes en stock.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          {stock.data &&
            stock.data.length > 0 &&
            stock.data[0]?.totalValuePen !== null &&
            stock.data[0]?.totalValuePen !== undefined && (
              <tfoot>
                <TableRow>
                  <TableCell colSpan={5} className="text-right font-medium">
                    Total valorizado
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatMoneyOrDash(totalPen.toFixed(4))}
                  </TableCell>
                  <TableCell />
                </TableRow>
              </tfoot>
            )}
        </Table>
      </div>
    </RoleGate>
  );
}
