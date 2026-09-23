'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  FISCAL_DOC_TYPE_LABELS,
  Role,
  businessToday,
  type MarginCostStatus,
  type SalesMarginDto,
  type SalesMarginOrderDto,
} from '@ayr/shared';
import { Stat, StatStrip } from '@/components/stat-strip';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { HeaderActions } from '@/components/header-actions';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
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

/**
 * Ventas y margen por rango (RF-S4a/M2). **Solo administrador**.
 *
 * La pantalla insiste en una distinción que un reporte de margen normalmente esconde: qué
 * tan comparable es el costo con la venta del rango. Una fila `PARCIAL` tiene costo de
 * verdad pero incompleto —el margen es un techo—, y una `NO_COMPARABLE` se muestra sin
 * costo y **fuera de los totales**, porque su venta del rango es una porción de un pedido
 * cuyo costo cubre más que eso. Prorratear daría un número inventado.
 */
export function VentasMargenView() {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(businessToday());

  const report = useQuery({
    queryKey: ['report', 'sales-margin', from, to],
    queryFn: () => api<SalesMarginDto>(`/reports/sales-margin?from=${from}&to=${to}`),
    enabled: from <= to,
  });

  const excluded = report.data?.orders.filter((o) => !o.inTotals) ?? [];
  const included = report.data?.orders.filter((o) => o.inTotals) ?? [];

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Ventas y margen</h1>
          <p className="text-xs text-muted-foreground">
            Comprobantes emitidos en el rango, sin IGV. Costo de venta desde el kardex.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="margen-desde">Desde</Label>
            <Input
              id="margen-desde"
              type="date"
              max={to}
              value={from}
              onChange={(e) => {
                if (e.target.value) setFrom(e.target.value);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="margen-hasta">Hasta</Label>
            <Input
              id="margen-hasta"
              type="date"
              min={from}
              value={to}
              onChange={(e) => {
                if (e.target.value) setTo(e.target.value);
              }}
            />
          </div>
          {/* Descarga directa contra el API (patrón D-149), con el mismo rango que se ve. */}
          <HeaderActions
            primary={['xlsx']}
            actions={[
              {
                key: 'xlsx',
                label: 'Descargar Excel',
                download: `/api/reports/sales-margin/xlsx?from=${from}&to=${to}`,
              },
            ]}
          />
        </div>
      </div>

      {report.data && (
        <StatStrip className="sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Venta sin IGV">{formatMoney(report.data.totals.salesPen)}</Stat>
          <Stat label="Costo de venta">{formatMoney(report.data.totals.costPen)}</Stat>
          <Stat label="Margen">{formatMoney(report.data.totals.marginPen)}</Stat>
          <Stat label="Margen %">
            {report.data.totals.marginPct === null ? '—' : `${report.data.totals.marginPct} %`}
          </Stat>
        </StatStrip>
      )}

      {report.data && report.data.totals.partialOrderCount > 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          {report.data.totals.partialOrderCount === 1
            ? '1 pedido tiene costo parcial: hay líneas facturadas que todavía no salieron del almacén, así que el margen de arriba es un techo.'
            : `${report.data.totals.partialOrderCount} pedidos tienen costo parcial: hay líneas facturadas que todavía no salieron del almacén, así que el margen de arriba es un techo.`}
        </p>
      )}

      {report.isPending && <Skeleton className="h-64 w-full" />}
      {report.isError && (
        <p role="alert" className="text-sm text-destructive">
          No se pudo cargar el reporte.
        </p>
      )}

      {report.data && (
        <>
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Por pedido</h2>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    <TableHead>Pedido</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead className="hidden lg:table-cell">Vendedor</TableHead>
                    <TableHead className="text-right">Venta</TableHead>
                    <TableHead className="text-right">Costo</TableHead>
                    <TableHead className="text-right">Margen</TableHead>
                    <TableHead className="text-right">%</TableHead>
                    <TableHead className="hidden text-right xl:table-cell">
                      Material de OPs
                    </TableHead>
                    <TableHead>Costo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {included.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-muted-foreground">
                        No hay comprobantes emitidos en ese rango.
                      </TableCell>
                    </TableRow>
                  )}
                  {included.map((order) => (
                    <OrderRow key={order.salesOrderId ?? order.documents[0]?.id} order={order} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

          {excluded.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Facturación parcial en el rango</h2>
              <p className="text-xs text-muted-foreground">
                Estos pedidos tienen comprobantes dentro y fuera del rango, y los del rango no
                declaran su despacho. Su costo cubre más venta que la que se ve acá, así que se
                muestra la venta y se deja el costo vacío: quedan fuera de los totales de arriba
                (venta excluida: {formatMoney(report.data.totals.excludedSalesPen)}).
              </p>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Pedido</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead className="text-right">Venta en el rango</TableHead>
                      <TableHead className="hidden text-right xl:table-cell">
                        Material de OPs
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {excluded.map((order) => (
                      <TableRow key={order.salesOrderId ?? order.documents[0]?.id}>
                        <TableCell className="font-mono">{order.orderCode ?? '—'}</TableCell>
                        <TableCell>{order.customerName}</TableCell>
                        <TableCell className="text-right">{formatMoney(order.salesPen)}</TableCell>
                        <TableCell className="hidden text-right xl:table-cell">
                          {formatMoney(order.opMaterialCostPen)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Totales por línea de negocio</h2>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Línea</TableHead>
                    <TableHead className="text-right">Venta</TableHead>
                    <TableHead className="text-right">Costo</TableHead>
                    <TableHead className="text-right">Margen</TableHead>
                    <TableHead className="text-right">%</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.data.totalsByLine.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground">
                        Sin ventas en el rango.
                      </TableCell>
                    </TableRow>
                  )}
                  {report.data.totalsByLine.map((t) => (
                    <TableRow key={t.businessLine ?? 'sin-linea'}>
                      <TableCell>
                        {t.businessLine === null
                          ? 'Sin línea (servicios y ajustes)'
                          : BUSINESS_LINE_LABELS[t.businessLine]}
                      </TableCell>
                      <TableCell className="text-right">{formatMoney(t.salesPen)}</TableCell>
                      <TableCell className="text-right">{formatMoney(t.costPen)}</TableCell>
                      <TableCell className="text-right">{formatMoney(t.marginPen)}</TableCell>
                      <TableCell className="text-right">
                        {t.marginPct === null ? '—' : `${t.marginPct} %`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        </>
      )}
    </RoleGate>
  );
}

/** Una fila de pedido con sus comprobantes debajo. */
function OrderRow({ order }: { order: SalesMarginOrderDto }) {
  return (
    <>
      <TableRow data-testid="fila-pedido">
        <TableCell className="font-mono">{order.orderCode ?? '—'}</TableCell>
        <TableCell>{order.customerName}</TableCell>
        <TableCell className="hidden lg:table-cell">{order.sellerName ?? '—'}</TableCell>
        <TableCell className="text-right">{formatMoney(order.salesPen)}</TableCell>
        <TableCell className="text-right">
          {order.costPen === null ? '—' : formatMoney(order.costPen)}
        </TableCell>
        <TableCell className="text-right">
          {order.marginPen === null ? '—' : formatMoney(order.marginPen)}
        </TableCell>
        <TableCell className="text-right">
          {order.marginPct === null ? '—' : `${order.marginPct} %`}
        </TableCell>
        <TableCell className="hidden text-right xl:table-cell text-muted-foreground">
          {formatMoney(order.opMaterialCostPen)}
        </TableCell>
        <TableCell>
          <CostStatusBadge status={order.costStatus} />
        </TableCell>
      </TableRow>
      {order.documents.map((d) => (
        <TableRow key={d.id} className="bg-muted/40 text-xs">
          <TableCell className="pl-8 font-mono">{d.number ?? '—'}</TableCell>
          <TableCell>{FISCAL_DOC_TYPE_LABELS[d.docType]}</TableCell>
          <TableCell className="hidden lg:table-cell">{formatDate(d.issueDate)}</TableCell>
          <TableCell className="text-right">{formatMoney(d.salesPen)}</TableCell>
          <TableCell className="text-right">
            {d.costPen === null ? (
              <span title="El despacho de este comprobante no está declarado (D-205)">—</span>
            ) : (
              formatMoney(d.costPen)
            )}
          </TableCell>
          <TableCell className="text-right">
            {d.marginPen === null ? '—' : formatMoney(d.marginPen)}
          </TableCell>
          <TableCell className="text-right">
            {d.marginPct === null ? '—' : `${d.marginPct} %`}
          </TableCell>
          <TableCell className="hidden xl:table-cell" />
          <TableCell />
        </TableRow>
      ))}
    </>
  );
}

const COST_STATUS_LABELS: Record<MarginCostStatus, string> = {
  COMPLETO: 'Completo',
  PARCIAL: 'Costo parcial',
  NO_COMPARABLE: 'No comparable',
};

function CostStatusBadge({ status }: { status: MarginCostStatus }) {
  if (status === 'COMPLETO') {
    return <Badge variant="secondary">{COST_STATUS_LABELS[status]}</Badge>;
  }
  return <Badge variant="destructive">{COST_STATUS_LABELS[status]}</Badge>;
}

/** Primer día del mes de negocio en curso, que es el rango por defecto más útil. */
function firstOfMonth(): string {
  return `${businessToday().slice(0, 7)}-01`;
}
