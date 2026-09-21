'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  PRODUCTION_ORDER_KIND_LABELS,
  PRODUCTION_ORDER_KINDS,
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_ORDER_STATUSES,
  type ProductionOrderKind,
  type ProductionOrderListItemDto,
  type ProductionOrderStatus,
} from '@ayr/shared';
import { PRODUCTION_ORDER_TONE } from '@/components/status-tone';
import { api } from '@/lib/api';
import { formatMoneyOrDash, formatQty, formatTimestampDate } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { LINK_CLASSNAME } from '@/lib/utils';

const ALL = 'ALL';

/**
 * Historial de producción (RF-34, RF-30): pedidos con sus OP dentro, de las dos líneas.
 *
 * **D-190: era la página `/produccion`** y salió de la navegación. La cola vive en `/planta`,
 * las órdenes de un pedido en su detalle, y este listado —el único lugar que mostraba las
 * cerradas, las anuladas y las corridas de drywall sin pedido, con su merma y su costo— se
 * reubicó en `/planta`. RF-S3b conserva el detalle de cada OP pero recupera la unidad mental
 * de la vista principal: primero el pedido, luego sus órdenes. Las corridas a stock quedan en
 * un grupo explícito y las rutas `/produccion/:id` siguen siendo el detalle auditable.
 *
 * Un solo listado para las dos líneas de transformación (D-087): comparten tabla,
 * correlativo y estados, y para quien las administra una orden es una orden.
 */
export function OrderHistory() {
  const [status, setStatus] = useState<ProductionOrderStatus | typeof ALL>(ALL);
  const [kind, setKind] = useState<ProductionOrderKind | typeof ALL>(ALL);

  const params = new URLSearchParams();
  if (status !== ALL) params.set('status', status);
  if (kind !== ALL) params.set('kind', kind);
  const queryString = params.size > 0 ? `?${params.toString()}` : '';
  const orders = useQuery({
    queryKey: ['production-orders', queryString],
    queryFn: () => api<ProductionOrderListItemDto[]>(`/production${queryString}`),
  });
  // El servidor ya entrega las OP por correlativo descendente (D-113). El primer encuentro
  // fija también el orden de los pedidos: actividad de producción más reciente primero.
  const groups = groupHistoryByOrder(orders.data ?? []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Historial de órdenes de producción</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v as ProductionOrderStatus | typeof ALL);
            }}
          >
            <SelectTrigger className="w-52" aria-label="Estado">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos los estados</SelectItem>
              {PRODUCTION_ORDER_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {PRODUCTION_ORDER_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={kind}
            onValueChange={(v) => {
              setKind(v as ProductionOrderKind | typeof ALL);
            }}
          >
            <SelectTrigger className="w-60" aria-label="Línea de transformación">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Las dos líneas</SelectItem>
              {PRODUCTION_ORDER_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {PRODUCTION_ORDER_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {orders.isPending && <Skeleton className="h-64 w-full" />}
        {orders.isError && (
          <p className="text-sm text-destructive">
            No se pudieron cargar las órdenes de producción.
          </p>
        )}
        {groups.map((group) => (
          <Card key={group.key}>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                {group.salesOrderId === null ? (
                  <span>Corridas sin pedido</span>
                ) : (
                  <Link href={`/pedidos/${group.salesOrderId}`} className={LINK_CLASSNAME}>
                    {group.salesOrderCode}
                  </Link>
                )}
                {group.customerName !== null && (
                  <span className="text-sm font-normal text-muted-foreground">
                    {group.customerName}
                  </span>
                )}
                <Badge variant="outline">
                  {group.orders.length} {group.orders.length === 1 ? 'orden' : 'órdenes'}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {group.orders.map((o) => (
                <div
                  key={o.id}
                  className="grid gap-2 rounded-lg border p-3 xl:grid-cols-[minmax(12rem,1.4fr)_repeat(5,minmax(7rem,auto))] xl:items-center"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/produccion/${o.id}`}
                      className={`font-mono font-medium ${LINK_CLASSNAME}`}
                    >
                      {o.code}
                    </Link>
                    <p className="break-words text-sm font-medium">
                      {o.productSku} · {o.productName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {PRODUCTION_ORDER_KIND_LABELS[o.kind]} · creada{' '}
                      {formatTimestampDate(o.createdAt)}
                    </p>
                  </div>
                  <HistoryMetric label="Producido" value={producedLabel(o)} />
                  <HistoryMetric label="Material" value={formatQty(o.assignedKg, 'kg')} />
                  <HistoryMetric
                    label="Merma"
                    value={o.scrapKg ? formatQty(o.scrapKg, 'kg') : '—'}
                  />
                  <HistoryMetric
                    label="Costo unit."
                    value={formatMoneyOrDash(o.unitCostPen, 'PEN', 4)}
                  />
                  <div className="xl:text-right">
                    <Badge variant={PRODUCTION_ORDER_TONE[o.status]}>
                      {PRODUCTION_ORDER_STATUS_LABELS[o.status]}
                    </Badge>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
        {orders.isSuccess && groups.length === 0 && (
          <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
            No hay órdenes de producción que coincidan con el filtro.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface HistoryGroup {
  key: string;
  salesOrderId: string | null;
  salesOrderCode: string | null;
  customerName: string | null;
  orders: ProductionOrderListItemDto[];
}

function groupHistoryByOrder(rows: readonly ProductionOrderListItemDto[]): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>();
  for (const order of rows) {
    const key = order.salesOrderId ?? 'sin-pedido';
    const group = groups.get(key) ?? {
      key,
      salesOrderId: order.salesOrderId,
      salesOrderCode: order.salesOrderCode,
      customerName: order.customerName,
      orders: [],
    };
    group.orders.push(order);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function producedLabel(order: ProductionOrderListItemDto): string {
  if (order.metersReported === null) {
    return order.targetPieces === null
      ? `${String(order.piecesReported)} pzs`
      : `${String(order.piecesReported)} / ${String(order.targetPieces)} pzs`;
  }
  return `${order.metersReported} m · ${String(order.piecesReported)} pzs`;
}

function HistoryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 xl:block xl:text-right">
      <span className="text-xs text-muted-foreground">{label}</span>
      <p className="text-sm tabular-nums">{value}</p>
    </div>
  );
}
