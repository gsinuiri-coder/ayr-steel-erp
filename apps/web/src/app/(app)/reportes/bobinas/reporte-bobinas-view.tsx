'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  COIL_STATUS_LABELS,
  businessMonth,
  Role,
  type CoilMonthReportDto,
} from '@ayr/shared';
import { Stat, StatStrip } from '@/components/stat-strip';
import { api } from '@/lib/api';
import { formatDate, formatMoney, formatQty } from '@/lib/format';
import { RoleGate } from '@/components/role-gate';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { LINK_CLASSNAME } from '@/lib/utils';
import { SortHead } from '@/components/sortable-table-head';
import { sortRows } from '@/lib/sort-rows';
import { useSort } from '@/lib/use-sort';

/**
 * Reporte mensual de bobinas.
 *
 * La columna que lo justifica es **Saldo inicio de mes**: cuántos kilos tenía cada bobina el
 * primer día del mes. Sale de sumar los movimientos de kardex anteriores al corte por su
 * fecha de operación (D-124), así que antes de que esa fecha existiera este reporte no se
 * podía calcular: todo lo registrado quedaba fechado el día en que se tipeó.
 *
 * "Saldo fin de mes" y no "Disponible": en un reporte de agosto, mostrar el saldo de hoy
 * sería mezclar dos cortes en la misma fila. En el mes en curso las dos cifras coinciden.
 */
export function ReporteBobinasView() {
  // D-323: la tabla muestra su lista entera; el orden por columna es sobre todas las filas.
  const [sort, toggleSort] = useSort<
    | 'code'
    | 'type'
    | 'line'
    | 'color'
    | 'width'
    | 'opening'
    | 'weight'
    | 'closing'
    | 'cost'
    | 'status'
  >();
  const [month, setMonth] = useState(businessMonth());

  const report = useQuery({
    queryKey: ['report', 'coils', month],
    queryFn: () => api<CoilMonthReportDto>(`/reports/coils?month=${month}`),
  });

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Reporte mensual de bobinas</h1>
          <p className="text-xs text-muted-foreground">
            {report.data
              ? `Del ${formatDate(report.data.from)} al ${formatDate(report.data.to)}`
              : 'Saldo al inicio del mes y al cierre, por bobina.'}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="reporte-mes">Mes</Label>
          <Input
            id="reporte-mes"
            type="month"
            max={businessMonth()}
            value={month}
            onChange={(e) => {
              if (e.target.value) setMonth(e.target.value);
            }}
          />
        </div>
      </div>

      {report.data && (
        <StatStrip className="sm:grid-cols-3 lg:grid-cols-3">
          <TotalCard title="Saldo inicio de mes" value={report.data.totals.openingKg} />
          <TotalCard title="Peso de alta" value={report.data.totals.weightKg} />
          <TotalCard title="Saldo fin de mes" value={report.data.totals.closingKg} />
        </StatStrip>
      )}

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <SortHead sort={sort} onSort={toggleSort} k="code">
                Código
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="type">
                Tipo
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="line" className="hidden md:table-cell">
                Línea
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="color">
                Color
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
                k="opening"
                className="text-right"
                align="right"
              >
                Saldo inicio mes (kg)
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="weight"
                className="text-right"
                align="right"
              >
                Peso (kg)
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="closing"
                className="text-right"
                align="right"
              >
                Saldo fin de mes (kg)
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="cost"
                className="hidden text-right lg:table-cell"
                align="right"
              >
                Costo/kg
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="status">
                Estado
              </SortHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.isPending && (
              <TableRow>
                <TableCell colSpan={10}>
                  <Skeleton className="h-24 w-full" />
                </TableCell>
              </TableRow>
            )}
            {report.isError && (
              <TableRow>
                <TableCell colSpan={10} className="text-destructive">
                  No se pudo cargar el reporte.
                </TableCell>
              </TableRow>
            )}
            {report.data?.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="text-muted-foreground">
                  No hay bobinas registradas hasta el final de ese mes.
                </TableCell>
              </TableRow>
            )}
            {sortRows(report.data?.rows ?? [], sort, {
              code: { text: (row) => row.code },
              type: { text: (row) => row.typeKey ?? '' },
              line: { text: (row) => row.businessLine },
              color: { text: (row) => row.colorName ?? '' },
              width: { decimal: (row) => String(row.widthMm) },
              opening: { decimal: (row) => String(row.openingKg) },
              weight: { decimal: (row) => String(row.weightKg) },
              closing: { decimal: (row) => String(row.closingKg) },
              cost: { decimal: (row) => String(row.unitCostPerKg ?? '') },
              status: { text: (row) => row.status },
            }).map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono">
                  <Link className={LINK_CLASSNAME} href={`/bobinas/${row.id}`}>
                    {row.code}
                  </Link>
                </TableCell>
                <TableCell>{row.typeKey}</TableCell>
                <TableCell className="hidden md:table-cell">
                  {BUSINESS_LINE_LABELS[row.businessLine]}
                </TableCell>
                <TableCell>{row.colorName ?? '—'}</TableCell>
                <TableCell className="text-right">{formatQty(row.widthMm, 'mm')}</TableCell>
                <TableCell className="text-right">{formatQty(row.openingKg)}</TableCell>
                <TableCell className="text-right">{formatQty(row.weightKg)}</TableCell>
                <TableCell className="text-right">{formatQty(row.closingKg)}</TableCell>
                <TableCell className="hidden text-right lg:table-cell">
                  {row.unitCostPerKg === null ? '—' : formatMoney(row.unitCostPerKg)}
                </TableCell>
                <TableCell>{COIL_STATUS_LABELS[row.status]}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </RoleGate>
  );
}

/** S11/D-179: la misma tira que el resto del sistema, en vez de tres tarjetas sueltas. */
function TotalCard({ title, value }: { title: string; value: string }) {
  return <Stat label={title}>{formatQty(value, 'kg')}</Stat>;
}
