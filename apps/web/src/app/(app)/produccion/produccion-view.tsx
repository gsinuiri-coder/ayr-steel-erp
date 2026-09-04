'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  PRODUCTION_ORDER_KIND_LABELS,
  PRODUCTION_ORDER_KINDS,
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_ORDER_STATUSES,
  Role,
  type ProductionOrderKind,
  type ProductionOrderListItemDto,
  type ProductionOrderStatus,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoneyOrDash, formatQty } from '@/lib/format';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const ALL = 'ALL';

const STATUS_VARIANT: Record<ProductionOrderStatus, 'default' | 'secondary' | 'outline'> = {
  DRAFT: 'outline',
  IN_PROGRESS: 'default',
  CLOSED: 'secondary',
  CANCELLED: 'outline',
};

/**
 * Órdenes de producción (RF-34, RF-30). Vista de administración; planta usa `/planta`.
 *
 * Un solo listado para las dos líneas de transformación (D-087): comparten tabla,
 * correlativo y estados, y para quien las administra una orden es una orden. Lo que cambia
 * por clase es qué producen —piezas o metros— y con qué material, y eso se distingue en la
 * fila y con el filtro.
 */
export function ProduccionView() {
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

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Producción</h1>
          <p className="text-sm text-muted-foreground">
            Perfiles de drywall desde fleje (RF-34) y coberturas metálicas desde bobina contra
            pedido (RF-30, RF-31), con trazabilidad hasta la bobina madre. La captura del operario
            está en{' '}
            <Link href="/planta" className="underline underline-offset-4">
              /planta
            </Link>
            .
          </p>
        </div>
        <Button asChild>
          <Link href="/planta">Ir a la terminal de planta</Link>
        </Button>
      </div>

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
          <TableHeader>
            <TableRow>
              <TableHead>Orden</TableHead>
              <TableHead>Producto</TableHead>
              <TableHead className="text-right">Producido</TableHead>
              <TableHead className="text-right">Material asignado</TableHead>
              <TableHead className="text-right">Merma</TableHead>
              <TableHead className="text-right">Costo unitario</TableHead>
              <TableHead>Creada</TableHead>
              <TableHead>Estado</TableHead>
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
            {orders.data?.map((o) => (
              <TableRow key={o.id}>
                <TableCell className="font-mono font-medium">
                  <Link href={`/produccion/${o.id}`} className="underline-offset-4 hover:underline">
                    {o.code}
                  </Link>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{o.productSku}</div>
                  <div className="text-xs text-muted-foreground">{o.productName}</div>
                  <div className="text-xs text-muted-foreground">
                    {PRODUCTION_ORDER_KIND_LABELS[o.kind]}
                    {o.salesOrderCode !== null && <> · {o.salesOrderCode}</>}
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
                <TableCell>{formatDate(o.createdAt.slice(0, 10))}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[o.status]}>
                    {PRODUCTION_ORDER_STATUS_LABELS[o.status]}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {orders.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  No hay órdenes de producción que coincidan con el filtro.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </RoleGate>
  );
}
