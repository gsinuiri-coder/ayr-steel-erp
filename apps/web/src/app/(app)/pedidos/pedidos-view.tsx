'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  SALES_ORDER_STATUS_LABELS,
  SALES_ORDER_STATUSES,
  Role,
  type SalesOrderListItemDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { RoleGate } from '@/components/role-gate';
import { SalesOrderStatusBadge } from '@/components/sales/status-badges';
import { useDebounced } from '@/lib/use-debounced';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
/** §3.4: el módulo comercial es de ADMINISTRADOR y VENDEDOR. */
const SALES_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

/** Pedidos (D-065). La reserva viva es lo que hace que el pedido signifique algo. */
export function PedidosView() {
  const [status, setStatus] = useState<string>(ALL);
  const [search, setSearch] = useState('');
  // Igual que en cotizaciones: la búsqueda por cliente va al API (RF-84) para que un pedido
  // fuera de las 500 más recientes se pueda encontrar.
  const debouncedSearch = useDebounced(search.trim(), 300);

  const params = new URLSearchParams();
  if (status !== ALL) params.set('status', status);
  if (debouncedSearch) params.set('search', debouncedSearch);
  const query = params.toString();

  const orders = useQuery({
    queryKey: ['sales-orders', status, debouncedSearch],
    queryFn: () => api<SalesOrderListItemDto[]>(`/sales/orders${query ? `?${query}` : ''}`),
  });

  const needle = search.trim().toLowerCase();
  const filtered = orders.data?.filter(
    (o) =>
      !needle ||
      o.code.toLowerCase().includes(needle) ||
      o.customerName.toLowerCase().includes(needle) ||
      o.customerDocNumber.includes(needle),
  );

  return (
    <RoleGate allow={SALES_ROLES}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Pedidos</h1>
          <p className="text-sm text-muted-foreground">
            Nacen de confirmar una cotización, o directo en las líneas que no la exigen (D-065).
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/pedidos/nuevo">Nuevo pedido directo</Link>
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Buscar por código, cliente o documento…"
          className="max-w-sm"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los estados</SelectItem>
            {SALES_ORDER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {SALES_ORDER_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Código</TableHead>
              <TableHead>Cliente</TableHead>
              <TableHead>Cotización</TableHead>
              <TableHead>Fecha</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Reservas activas</TableHead>
              <TableHead>Estado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {orders.isError && (
              <TableRow>
                <TableCell colSpan={7} className="text-destructive">
                  No se pudieron cargar los pedidos.
                </TableCell>
              </TableRow>
            )}
            {filtered?.map((o) => (
              <TableRow key={o.id}>
                <TableCell className="font-medium">
                  <Link href={`/pedidos/${o.id}`} className="underline-offset-4 hover:underline">
                    {o.code}
                  </Link>
                </TableCell>
                <TableCell>
                  <div>{o.customerName}</div>
                  <div className="text-xs text-muted-foreground">{o.customerDocNumber}</div>
                </TableCell>
                <TableCell>
                  {o.quotationId ? (
                    <Link
                      href={`/cotizaciones/${o.quotationId}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {o.quotationCode}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">Directo</span>
                  )}
                </TableCell>
                <TableCell>{formatDate(o.issueDate)}</TableCell>
                <TableCell className="text-right">{formatMoney(o.totalPen)}</TableCell>
                <TableCell className="text-right">{o.activeReservations}</TableCell>
                <TableCell>
                  <SalesOrderStatusBadge status={o.status} />
                </TableCell>
              </TableRow>
            ))}
            {filtered?.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  {search || status !== ALL
                    ? 'Ningún pedido coincide con el filtro.'
                    : 'No hay pedidos todavía.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </RoleGate>
  );
}
