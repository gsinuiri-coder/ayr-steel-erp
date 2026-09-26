'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { PRODUCTION_ORDER_STATUS_LABELS, type ProductionOrderListItemDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { formatQty } from '@/lib/format';
import { LINK_CLASSNAME } from '@/lib/utils';
import { sortRows } from '@/lib/sort-rows';
import { useSort } from '@/lib/use-sort';
import { SortableTableHead } from '@/components/sortable-table-head';
import { OrderPriorityControl } from '@/components/production-queue';
import { PRODUCTION_ORDER_TONE } from '@/components/status-tone';
import { Badge } from '@/components/ui/badge';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
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
 * D-190: **las órdenes de producción viven en el pedido.** Feedback del cliente: el listado
 * suelto de `/produccion` era confuso, y lo que se quiere ver de una orden casi siempre se
 * pregunta desde su pedido. Esta tarjeta muestra todas las del pedido —vivas, cerradas y
 * anuladas— con su estado, la bobina montada, el avance en metros y la prioridad, y lleva al
 * workspace de `/planta` (producir) o al detalle de la orden (costos, kardex, correcciones).
 *
 * Solo ADMINISTRADOR: el detalle del pedido lo ve también VENDEDOR, pero `GET /production`
 * trae costos y es de ADMINISTRADOR y SUPERVISOR_PLANTA (§3.4). VENDEDOR sigue viendo el
 * estado derivado del pedido (`En cola` / `En producción`).
 */
export function ProductionOrdersCard({
  salesOrderId,
  canOperate,
}: {
  salesOrderId: string;
  canOperate: boolean;
}) {
  const orders = useQuery({
    queryKey: ['production-orders', 'sales-order', salesOrderId],
    queryFn: () => api<ProductionOrderListItemDto[]>(`/production?salesOrderId=${salesOrderId}`),
  });
  // D-323: las órdenes de un pedido no paginan; el orden por columna es sobre todas.
  const [sort, toggleSort] = useSort<'code' | 'product' | 'status'>();
  const allRows = [...(orders.data ?? [])].sort((a, b) => a.code.localeCompare(b.code));
  const rows = sortRows(allRows, sort, {
    code: { text: (o) => o.code },
    product: { text: (o) => `${o.productSku} ${o.productName}` },
    status: {
      text: (o) =>
        o.status === 'DRAFT' && o.kind === 'ROOFING'
          ? 'En cola'
          : PRODUCTION_ORDER_STATUS_LABELS[o.status],
    },
  });

  if (orders.isSuccess && allRows.length === 0) return null;

  return (
    <Section title="Órdenes de producción">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <SortableTableHead
              active={sort.key === 'code'}
              dir={sort.dir}
              onClick={() => {
                toggleSort('code');
              }}
            >
              Orden
            </SortableTableHead>
            <SortableTableHead
              active={sort.key === 'product'}
              dir={sort.dir}
              onClick={() => {
                toggleSort('product');
              }}
            >
              Producto
            </SortableTableHead>
            <SortableTableHead
              active={sort.key === 'status'}
              dir={sort.dir}
              onClick={() => {
                toggleSort('status');
              }}
            >
              Estado
            </SortableTableHead>
            <TableHead>Bobina montada</TableHead>
            <TableHead className="text-right">Avance</TableHead>
            <TableHead className="text-right">Acciones</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.isPending && (
            <TableRow>
              <TableCell colSpan={6}>
                <Skeleton className="h-5 w-full" />
              </TableCell>
            </TableRow>
          )}
          {orders.isError && (
            <TableRow>
              <TableCell colSpan={6} className="text-destructive">
                No se pudieron cargar las órdenes de producción del pedido.
              </TableCell>
            </TableRow>
          )}
          {rows.map((o) => {
            const live = o.status === 'DRAFT' || o.status === 'IN_PROGRESS';
            return (
              <TableRow key={o.id} className={o.status === 'CANCELLED' ? 'opacity-60' : undefined}>
                <TableCell className="font-mono font-medium">
                  <Link href={`/produccion/${o.id}`} className={LINK_CLASSNAME}>
                    {o.code}
                  </Link>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{o.productSku}</div>
                  <div className="text-xs text-muted-foreground">{o.productName}</div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge variant={PRODUCTION_ORDER_TONE[o.status]}>
                      {o.status === 'DRAFT' && o.kind === 'ROOFING'
                        ? 'En cola'
                        : PRODUCTION_ORDER_STATUS_LABELS[o.status]}
                    </Badge>
                    {live && o.priority && <Badge>Prioridad</Badge>}
                  </div>
                  {live && o.priority && o.priorityReason && (
                    <div className="text-xs text-muted-foreground">
                      {o.priorityReason}
                      {o.priorityByName ? ` — ${o.priorityByName}` : ''}
                    </div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-sm">
                  {o.mountedCoilCodes.length > 0 ? (
                    o.mountedCoilCodes.join(', ')
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {o.planMeters !== null ? (
                    <>
                      {formatQty(o.metersReported ?? '0.000', 'm')}
                      <span className="text-muted-foreground">
                        {' '}
                        de {formatQty(o.planMeters, 'm')}
                      </span>
                    </>
                  ) : (
                    <>
                      {o.piecesReported}
                      {o.targetPieces !== null && (
                        <span className="text-muted-foreground"> / {o.targetPieces}</span>
                      )}{' '}
                      pzs
                    </>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {live && canOperate && o.kind === 'ROOFING' && (
                      <OrderPriorityControl
                        orderId={o.id}
                        orderCode={o.code}
                        priority={o.priority}
                      />
                    )}
                    {live && canOperate && (
                      <Button variant="outline" size="sm" asChild>
                        <Link
                          href={`/planta?pedido=${salesOrderId}&op=${o.id}`}
                          aria-label={`Producir ${o.code}`}
                        >
                          Producir
                        </Link>
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Section>
  );
}
