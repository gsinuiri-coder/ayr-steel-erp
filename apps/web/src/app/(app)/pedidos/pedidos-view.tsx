'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  SALES_ORDER_STATUS_LABELS,
  SALES_ORDER_STATUSES,
  Role,
  type PaginatedResult,
  type SalesOrderListItemDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { RoleGate } from '@/components/role-gate';
import { SalesOrderStatusBadge } from '@/components/sales/status-badges';
import { useDebounced } from '@/lib/use-debounced';
import { usePagination } from '@/lib/use-pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PaginationBar } from '@/components/pagination-bar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { customerSearchHref, LINK_CLASSNAME } from '@/lib/utils';
import { compareBy, compareDecimalBy, useSort } from '@/lib/use-sort';
import { SortableTableHead } from '@/components/sortable-table-head';
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
  // La búsqueda va al API (RF-84) para que un pedido fuera de la página actual se pueda
  // encontrar: por nombre/documento del cliente, o por código (extrae el número de "PED-…").
  const debouncedSearch = useDebounced(search.trim(), 300);
  const { page, pageSize, setPage, setPageSize, resetPage } = usePagination();

  useEffect(() => {
    resetPage();
  }, [status, debouncedSearch, resetPage]);

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (status !== ALL) params.set('status', status);
  if (debouncedSearch) params.set('search', debouncedSearch);

  const orders = useQuery({
    queryKey: ['sales-orders', page, pageSize, status, debouncedSearch],
    queryFn: () =>
      api<PaginatedResult<SalesOrderListItemDto>>(`/sales/orders?${params.toString()}`),
  });

  // S10b/M1: sort sobre la página actual, no sobre el total — el orden por defecto del
  // servidor (descendente) no se toca salvo que el usuario clickee una columna.
  const [sort, toggleSort] = useSort<'code' | 'customer' | 'issueDate' | 'total' | 'status'>();
  const unsortedRows = orders.data?.items ?? [];
  const rows =
    sort.key === null
      ? unsortedRows
      : [...unsortedRows].sort((a, b) => {
          switch (sort.key) {
            case 'code':
              return compareBy(sort.dir, a.code, b.code);
            case 'customer':
              return compareBy(
                sort.dir,
                a.customerName.toLowerCase(),
                b.customerName.toLowerCase(),
              );
            case 'issueDate':
              return compareBy(sort.dir, a.issueDate, b.issueDate);
            case 'total':
              return compareDecimalBy(sort.dir, a.totalPen, b.totalPen);
            case 'status':
              return compareBy(sort.dir, a.status, b.status);
            default:
              return 0;
          }
        });

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
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <SortableTableHead
                active={sort.key === 'code'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('code');
                }}
              >
                Código
              </SortableTableHead>
              <SortableTableHead
                active={sort.key === 'customer'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('customer');
                }}
              >
                Cliente
              </SortableTableHead>
              <TableHead className="hidden md:table-cell">Cotización</TableHead>
              <SortableTableHead
                active={sort.key === 'issueDate'}
                dir={sort.dir}
                className="hidden sm:table-cell"
                onClick={() => {
                  toggleSort('issueDate');
                }}
              >
                Fecha
              </SortableTableHead>
              <SortableTableHead
                active={sort.key === 'total'}
                dir={sort.dir}
                align="right"
                className="text-right"
                onClick={() => {
                  toggleSort('total');
                }}
              >
                Total
              </SortableTableHead>
              <TableHead className="hidden text-right lg:table-cell">Reservas activas</TableHead>
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
            {rows.map((o) => (
              <TableRow key={o.id}>
                <TableCell className="font-medium">
                  <Link href={`/pedidos/${o.id}`} className={LINK_CLASSNAME}>
                    {o.code}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link href={customerSearchHref(o.customerDocNumber)} className={LINK_CLASSNAME}>
                    {o.customerName}
                  </Link>
                  <div className="text-xs text-muted-foreground">{o.customerDocNumber}</div>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {o.quotationId ? (
                    <Link href={`/cotizaciones/${o.quotationId}`} className={LINK_CLASSNAME}>
                      {o.quotationCode}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">Directo</span>
                  )}
                </TableCell>
                <TableCell className="hidden sm:table-cell">{formatDate(o.issueDate)}</TableCell>
                <TableCell className="text-right">{formatMoney(o.totalPen)}</TableCell>
                <TableCell className="hidden text-right lg:table-cell">
                  {o.activeReservations}
                </TableCell>
                <TableCell>
                  <SalesOrderStatusBadge status={o.status} />
                </TableCell>
              </TableRow>
            ))}
            {orders.isSuccess && rows.length === 0 && (
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
      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={orders.data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={orders.isFetching}
      />
    </RoleGate>
  );
}
