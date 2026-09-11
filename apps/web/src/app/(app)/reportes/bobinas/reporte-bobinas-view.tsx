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
import { api } from '@/lib/api';
import { formatDate, formatMoney, formatQty } from '@/lib/format';
import { RoleGate } from '@/components/role-gate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
        <div className="grid gap-4 sm:grid-cols-3">
          <TotalCard title="Saldo inicio de mes" value={report.data.totals.openingKg} />
          <TotalCard title="Peso de alta" value={report.data.totals.weightKg} />
          <TotalCard title="Saldo fin de mes" value={report.data.totals.closingKg} />
        </div>
      )}

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead>Código</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead className="hidden md:table-cell">Línea</TableHead>
              <TableHead>Color</TableHead>
              <TableHead className="text-right">Ancho</TableHead>
              <TableHead className="text-right">Saldo inicio mes (kg)</TableHead>
              <TableHead className="text-right">Peso (kg)</TableHead>
              <TableHead className="text-right">Saldo fin de mes (kg)</TableHead>
              <TableHead className="hidden text-right lg:table-cell">Costo/kg</TableHead>
              <TableHead>Estado</TableHead>
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
            {report.data?.rows.map((row) => (
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

function TotalCard({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-2xl font-semibold">{formatQty(value, 'kg')}</CardContent>
    </Card>
  );
}
