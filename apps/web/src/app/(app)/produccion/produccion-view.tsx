'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_ORDER_STATUSES,
  Role,
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

/** Órdenes de producción de drywall (RF-34). Vista de administración; planta usa `/planta`. */
export function ProduccionView() {
  const [status, setStatus] = useState<ProductionOrderStatus | typeof ALL>(ALL);

  const queryString = status === ALL ? '' : `?status=${status}`;
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
            Órdenes de perfiles de drywall (RF-34): consumen flejes y producen piezas, con
            trazabilidad hasta la bobina madre. La captura del operario está en{' '}
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
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Orden</TableHead>
              <TableHead>Producto</TableHead>
              <TableHead className="text-right">Piezas</TableHead>
              <TableHead className="text-right">Fleje asignado</TableHead>
              <TableHead className="text-right">Merma</TableHead>
              <TableHead className="text-right">Costo/pieza</TableHead>
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
                </TableCell>
                <TableCell className="text-right">
                  {o.piecesReported}
                  {o.targetPieces !== null && (
                    <span className="text-muted-foreground"> / {o.targetPieces}</span>
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
