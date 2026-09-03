'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  BUSINESS_LINES,
  CUTTING_ORDER_STATUS_LABELS,
  CUTTING_ORDER_STATUSES,
  Role,
  type BusinessLine,
  type CuttingOrderListItemDto,
  type CuttingOrderStatus,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
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

const STATUS_VARIANT: Record<CuttingOrderStatus, 'default' | 'secondary' | 'outline'> = {
  SENT: 'outline',
  PARTIALLY_RECEIVED: 'default',
  RECEIVED: 'secondary',
  CANCELLED: 'outline',
};

/** Órdenes de corte tercerizado (RF-40..42, RF-22), filtrables por línea y estado. */
export function CorteView() {
  const [businessLine, setBusinessLine] = useState<BusinessLine | typeof ALL>(ALL);
  const [status, setStatus] = useState<CuttingOrderStatus | typeof ALL>(ALL);

  const params = new URLSearchParams();
  if (businessLine !== ALL) params.set('businessLine', businessLine);
  if (status !== ALL) params.set('status', status);
  const queryString = params.toString();

  const orders = useQuery({
    queryKey: ['cutting-orders', queryString],
    queryFn: () =>
      api<CuttingOrderListItemDto[]>(`/cutting${queryString ? `?${queryString}` : ''}`),
  });

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Corte tercerizado</h1>
          <p className="text-sm text-muted-foreground">
            Bobinas enviadas a un tercero para partir en flejes (RF-40..42). El envío no mueve
            kardex: la bobina sigue siendo propia hasta que se recibe.
          </p>
        </div>
        <Button asChild>
          <Link href="/corte/nueva">Enviar bobinas a corte</Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={businessLine}
          onValueChange={(v) => {
            setBusinessLine(v as BusinessLine | typeof ALL);
          }}
        >
          <SelectTrigger className="w-52" aria-label="Línea de negocio">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todas las líneas</SelectItem>
            {BUSINESS_LINES.map((line) => (
              <SelectItem key={line} value={line}>
                {BUSINESS_LINE_LABELS[line]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v as CuttingOrderStatus | typeof ALL);
          }}
        >
          <SelectTrigger className="w-52" aria-label="Estado">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los estados</SelectItem>
            {CUTTING_ORDER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {CUTTING_ORDER_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Proveedor</TableHead>
              <TableHead>Línea</TableHead>
              <TableHead className="text-right">Bobinas</TableHead>
              <TableHead>Enviada</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Notas</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {orders.isError && (
              <TableRow>
                <TableCell colSpan={6} className="text-destructive">
                  No se pudieron cargar las órdenes de corte.
                </TableCell>
              </TableRow>
            )}
            {orders.data?.map((o) => (
              <TableRow key={o.id}>
                <TableCell className="font-medium">
                  <Link href={`/corte/${o.id}`} className="underline-offset-4 hover:underline">
                    {o.supplierName}
                  </Link>
                </TableCell>
                <TableCell>{BUSINESS_LINE_LABELS[o.businessLine]}</TableCell>
                <TableCell className="text-right">{o.coilCount}</TableCell>
                <TableCell>{formatDate(o.sentAt.slice(0, 10))}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[o.status]}>
                    {CUTTING_ORDER_STATUS_LABELS[o.status]}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">
                  {o.notes ?? ''}
                </TableCell>
              </TableRow>
            ))}
            {orders.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No hay órdenes de corte que coincidan con los filtros.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </RoleGate>
  );
}
