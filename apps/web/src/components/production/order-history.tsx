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
import { SortableTableHead } from '@/components/sortable-table-head';
import { compareBy, useSort } from '@/lib/use-sort';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const ALL = 'ALL';

/**
 * Historial de órdenes de producción (RF-34, RF-30): todas, de las dos líneas, con filtros.
 *
 * **D-190: era la página `/produccion`** y salió de la navegación. La cola vive en `/planta`,
 * las órdenes de un pedido en su detalle, y este listado —el único lugar que mostraba las
 * cerradas, las anuladas y las corridas de drywall sin pedido, con su merma y su costo— se
 * reubicó entero como sección plegable de `/planta`. No se perdió ninguna columna.
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
  // S10b/M1: esta lista no pagina (D-113 la deja en un tope de 500, no en páginas), así
  // que el sort acá sí cubre el conjunto entero, no solo lo visible. El orden por defecto
  // del servidor (por `seq` descendente) no se toca salvo que el usuario clickee.
  const [sort, toggleSort] = useSort<'code' | 'createdAt' | 'status'>();
  const rows =
    sort.key === null
      ? (orders.data ?? [])
      : [...(orders.data ?? [])].sort((a, b) => {
          switch (sort.key) {
            case 'code':
              return compareBy(sort.dir, a.code, b.code);
            case 'createdAt':
              return compareBy(sort.dir, a.createdAt, b.createdAt);
            case 'status':
              return compareBy(sort.dir, a.status, b.status);
            default:
              return 0;
          }
        });

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

        <div className="rounded-lg border">
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
                <TableHead>Producto</TableHead>
                <TableHead className="text-right">Producido</TableHead>
                <TableHead className="text-right">Material asignado</TableHead>
                <TableHead className="text-right">Merma</TableHead>
                <TableHead className="text-right">Costo unitario</TableHead>
                <SortableTableHead
                  active={sort.key === 'createdAt'}
                  dir={sort.dir}
                  onClick={() => {
                    toggleSort('createdAt');
                  }}
                >
                  Creada
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.isPending &&
                [0, 1, 2].map((i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={8}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {orders.isError && (
                <TableRow>
                  <TableCell colSpan={8} className="text-destructive">
                    No se pudieron cargar las órdenes de producción.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="font-mono font-medium">
                    <Link href={`/produccion/${o.id}`} className={LINK_CLASSNAME}>
                      {o.code}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">
                      {o.productSku}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {o.productName}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {PRODUCTION_ORDER_KIND_LABELS[o.kind]}
                      {o.salesOrderCode !== null && o.salesOrderId !== null && (
                        <>
                          {' · '}
                          <Link href={`/pedidos/${o.salesOrderId}`} className={LINK_CLASSNAME}>
                            {o.salesOrderCode}
                          </Link>
                        </>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {/* D-083: una cobertura a medida se produce en metros, no en piezas. */}
                    {o.metersReported === null ? (
                      <>
                        {o.piecesReported}
                        {o.targetPieces !== null && (
                          <span className="text-muted-foreground"> / {o.targetPieces}</span>
                        )}
                      </>
                    ) : (
                      <>
                        {o.metersReported} m
                        <span className="text-muted-foreground"> · {o.piecesReported} pzs</span>
                      </>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{formatQty(o.assignedKg, 'kg')}</TableCell>
                  <TableCell className="text-right">
                    {o.scrapKg ? formatQty(o.scrapKg, 'kg') : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatMoneyOrDash(o.unitCostPen, 'PEN', 4)}
                  </TableCell>
                  <TableCell>{formatTimestampDate(o.createdAt)}</TableCell>
                  <TableCell>
                    <Badge variant={PRODUCTION_ORDER_TONE[o.status]}>
                      {PRODUCTION_ORDER_STATUS_LABELS[o.status]}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {orders.isSuccess && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No hay órdenes de producción que coincidan con el filtro.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
