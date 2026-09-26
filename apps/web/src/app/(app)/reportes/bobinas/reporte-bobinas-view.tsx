'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  businessMonth,
  coilStateLabel,
  Role,
  type CoilFilmState,
  type CoilMonthReportDto,
  type CoilMonthReportSectionDto,
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
  TableFooter,
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
 *
 * D-328: va en **dos tablas** —«Selladas» y «Abiertas»— según el film de cada bobina **al último
 * día del mes**, cada una con su subtotal, y un total general que es su suma. Las terminadas con
 * saldo final 0 van en «Abiertas».
 */
export function ReporteBobinasView() {
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
        <StatStrip
          aria-label="Total general"
          className={
            report.data.totals.closingValuePen === null
              ? 'sm:grid-cols-3 lg:grid-cols-3'
              : 'sm:grid-cols-4 lg:grid-cols-4'
          }
        >
          <Stat label="Saldo inicio de mes">{formatQty(report.data.totals.openingKg, 'kg')}</Stat>
          <Stat label="Peso de alta">{formatQty(report.data.totals.weightKg, 'kg')}</Stat>
          <Stat label="Saldo fin de mes">{formatQty(report.data.totals.closingKg, 'kg')}</Stat>
          {report.data.totals.closingValuePen !== null && (
            <Stat label="Valor fin de mes">{formatMoney(report.data.totals.closingValuePen)}</Stat>
          )}
        </StatStrip>
      )}

      {report.isPending && <Skeleton className="h-24 w-full" />}
      {report.isError && <p className="text-destructive">No se pudo cargar el reporte.</p>}
      {report.data && (
        <>
          <MonthTable
            title="Selladas"
            film="SEALED"
            section={report.data.sealed}
            emptyText="No había bobinas selladas al final de ese mes."
          />
          <MonthTable
            title="Abiertas"
            film="OPENED"
            section={report.data.opened}
            emptyText="No había bobinas abiertas al final de ese mes."
            note="Incluye las terminadas, con saldo final 0."
          />
        </>
      )}
    </RoleGate>
  );
}

type SortKey =
  | 'code'
  | 'type'
  | 'line'
  | 'color'
  | 'width'
  | 'opening'
  | 'weight'
  | 'closing'
  | 'cost'
  | 'value'
  | 'status';

/** Una de las dos tablas del reporte, con su propio orden por columna (D-323) y su subtotal. */
function MonthTable({
  title,
  film,
  section,
  emptyText,
  note,
}: {
  title: string;
  film: CoilFilmState;
  section: CoilMonthReportSectionDto;
  emptyText: string;
  note?: string;
}) {
  // D-323: la tabla muestra su lista entera; el orden por columna es sobre todas las filas.
  const [sort, toggleSort] = useSort<SortKey>(film === 'SEALED' ? 'sellada' : 'abierta');
  const showsCost = section.totals.closingValuePen !== null;
  const colSpan = showsCost ? 11 : 9;

  return (
    <section aria-label={`Bobinas ${title.toLowerCase()}`} className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">
          {section.rows.length} {section.rows.length === 1 ? 'bobina' : 'bobinas'}
          {note ? ` · ${note}` : ''}
        </p>
      </div>
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
              {showsCost && (
                <SortHead
                  sort={sort}
                  onSort={toggleSort}
                  k="cost"
                  className="hidden text-right lg:table-cell"
                  align="right"
                >
                  Costo/kg
                </SortHead>
              )}
              {showsCost && (
                <SortHead
                  sort={sort}
                  onSort={toggleSort}
                  k="value"
                  className="text-right"
                  align="right"
                >
                  Valor fin de mes
                </SortHead>
              )}
              <SortHead sort={sort} onSort={toggleSort} k="status">
                Estado
              </SortHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {section.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-muted-foreground">
                  {emptyText}
                </TableCell>
              </TableRow>
            )}
            {sortRows(section.rows, sort, {
              code: { text: (row) => row.code },
              type: { text: (row) => row.typeKey },
              line: { text: (row) => row.businessLine },
              color: { text: (row) => row.colorName ?? '' },
              width: { decimal: (row) => row.widthMm },
              opening: { decimal: (row) => row.openingKg },
              weight: { decimal: (row) => row.weightKg },
              closing: { decimal: (row) => row.closingKg },
              cost: { decimal: (row) => row.unitCostPerKg ?? '' },
              value: { decimal: (row) => row.closingValuePen ?? '' },
              status: { text: (row) => coilStateLabel({ status: row.status, film }) },
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
                {showsCost && (
                  <TableCell className="hidden text-right lg:table-cell">
                    {row.unitCostPerKg === null ? '—' : formatMoney(row.unitCostPerKg)}
                  </TableCell>
                )}
                {showsCost && (
                  <TableCell className="text-right">
                    {row.closingValuePen === null ? '—' : formatMoney(row.closingValuePen)}
                  </TableCell>
                )}
                <TableCell>{coilStateLabel({ status: row.status, film })}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={5} className="font-medium">
                Subtotal {title}
              </TableCell>
              <TableCell className="text-right font-medium">
                {formatQty(section.totals.openingKg)}
              </TableCell>
              <TableCell className="text-right font-medium">
                {formatQty(section.totals.weightKg)}
              </TableCell>
              <TableCell className="text-right font-medium">
                {formatQty(section.totals.closingKg)}
              </TableCell>
              {showsCost && <TableCell className="hidden lg:table-cell" />}
              {showsCost && (
                <TableCell className="text-right font-medium">
                  {section.totals.closingValuePen === null
                    ? '—'
                    : formatMoney(section.totals.closingValuePen)}
                </TableCell>
              )}
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </section>
  );
}
