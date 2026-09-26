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
import { CUTTING_ORDER_TONE } from '@/components/status-tone';
import { api } from '@/lib/api';
import { formatTimestampDate } from '@/lib/format';
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
import { LINK_CLASSNAME } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortHead } from '@/components/sortable-table-head';
import { sortRows } from '@/lib/sort-rows';
import { useSort } from '@/lib/use-sort';

const ALL = 'ALL';

/** Órdenes de corte tercerizado (RF-40..42, RF-22), filtrables por línea y estado. */
export function CorteView() {
  // D-323: la tabla muestra su lista entera; el orden por columna es sobre todas las filas.
  const [sort, toggleSort] = useSort<'supplier' | 'line' | 'coils' | 'sent' | 'status'>();
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
          <h1 className="text-lg font-semibold">Corte tercerizado</h1>
          <p className="text-xs text-muted-foreground">
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
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <SortHead sort={sort} onSort={toggleSort} k="supplier">
                Proveedor
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="line">
                Línea
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="coils"
                className="text-right"
                align="right"
              >
                Bobinas
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="sent">
                Enviada
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="status">
                Estado
              </SortHead>
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
            {sortRows(orders.data ?? [], sort, {
              supplier: { text: (o) => o.supplierName },
              line: { text: (o) => o.businessLine },
              coils: { decimal: (o) => String(o.coilCount) },
              sent: { text: (o) => o.sentAt ?? '' },
              status: { text: (o) => o.status },
            }).map((o) => (
              <TableRow key={o.id}>
                <TableCell className="font-medium">
                  <Link href={`/corte/${o.id}`} className={LINK_CLASSNAME}>
                    {o.supplierName}
                  </Link>
                </TableCell>
                <TableCell>{BUSINESS_LINE_LABELS[o.businessLine]}</TableCell>
                <TableCell className="text-right">{o.coilCount}</TableCell>
                <TableCell>{formatTimestampDate(o.sentAt)}</TableCell>
                <TableCell>
                  <Badge variant={CUTTING_ORDER_TONE[o.status]}>
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
