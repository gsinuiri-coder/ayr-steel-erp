'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  businessToday,
  UNDISPATCHED_AT_CLOSE_STATUS_LABELS,
  type UndispatchedAtCloseDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { LINK_CLASSNAME } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * cc56 (D-670) — «Facturado y no despachado al cierre»: los comprobantes del período cuya mercadería
 * sale del kardex después del cierre (o todavía no salió), con el costo de Ventas y margen y la fecha
 * de salida real. Solo informa: no cambia el reporte en el que aparece. Lo usan Ventas y margen y el
 * inventario valorizado.
 */
export function UndispatchedAtClose({ from, to }: { from: string; to: string }) {
  const report = useQuery({
    queryKey: ['report', 'undispatched-at-close', from, to],
    queryFn: () =>
      api<UndispatchedAtCloseDto>(`/reports/undispatched-at-close?from=${from}&to=${to}`),
  });
  const data = report.data;
  return (
    <section className="grid gap-2" data-testid="facturado-no-despachado">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Facturado y no despachado al cierre</h2>
          <p className="text-xs text-muted-foreground">
            Comprobantes del {formatDate(from)} al {formatDate(to)} con mercadería que al{' '}
            {formatDate(to)} no había salido del kardex (lo facturado menos lo despachado, por línea
            de pedido). El costo estimado es el de Ventas y margen en la proporción pendiente; esa
            mercadería todavía figura en el inventario al cierre.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a href={`/api/reports/undispatched-at-close/xlsx?from=${from}&to=${to}`} download>
            Descargar Excel
          </a>
        </Button>
      </div>
      {report.isPending && <Skeleton className="h-16 w-full" />}
      {report.isError && (
        <p className="text-sm text-destructive">No se pudo cargar lo facturado y no despachado.</p>
      )}
      {data?.rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Todo lo facturado en el período salió del kardex dentro del período.
        </p>
      )}
      {data && data.rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Comprobante</TableHead>
              <TableHead>Emisión</TableHead>
              <TableHead>Cliente</TableHead>
              <TableHead className="text-right">Venta sin IGV</TableHead>
              <TableHead className="text-right">Costo estimado</TableHead>
              <TableHead>Salida real</TableHead>
              <TableHead>Estado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((r) => (
              <TableRow key={r.documentId} data-testid="fila-facturado-no-despachado">
                <TableCell>
                  <Link href={`/comprobantes/${r.documentId}`} className={LINK_CLASSNAME}>
                    {r.number}
                  </Link>
                </TableCell>
                <TableCell>{formatDate(r.issueDate)}</TableCell>
                <TableCell className="max-w-64 truncate">{r.customerName}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(r.salesPen)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.estimatedCostPen === null ? '—' : formatMoney(r.estimatedCostPen)}
                </TableCell>
                <TableCell>
                  {r.dispatchDates.length === 0
                    ? '—'
                    : r.dispatchDates.map((d) => formatDate(d)).join(', ')}
                </TableCell>
                <TableCell>{UNDISPATCHED_AT_CLOSE_STATUS_LABELS[r.status]}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={3}>
                Total · {data.totals.count}{' '}
                {data.totals.count === 1 ? 'comprobante' : 'comprobantes'}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMoney(data.totals.salesPen)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMoney(data.totals.estimatedCostPen)}
              </TableCell>
              <TableCell colSpan={2}>
                {data.totals.withoutCostCount > 0
                  ? `${String(data.totals.withoutCostCount)} sin costo estimado`
                  : ''}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      )}
    </section>
  );
}

/** El mes anterior al de hoy en Lima (`YYYY-MM`). */
function previousMonth(): string {
  const [y, m] = businessToday().split('-').map(Number) as [number, number];
  return m === 1 ? `${String(y - 1)}-12` : `${String(y)}-${String(m - 1).padStart(2, '0')}`;
}

function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/**
 * cc56 (D-670): la misma sección para el inventario valorizado, que es «a hoy»: el cierre se elige
 * por mes (por defecto, el anterior).
 */
export function UndispatchedAtCloseMonth() {
  const [month, setMonth] = useState(previousMonth);
  const valid = /^\d{4}-\d{2}$/.test(month);
  return (
    <div className="grid gap-2 border-t pt-4">
      <div className="flex items-center gap-2">
        <Label htmlFor="cierre-mes" className="text-sm">
          Cierre de
        </Label>
        <Input
          id="cierre-mes"
          type="month"
          className="w-44"
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
          }}
        />
      </div>
      {valid && <UndispatchedAtClose {...monthRange(month)} />}
    </div>
  );
}
