'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  DISPATCH_STATUS_LABELS,
  DISPATCH_STATUSES,
  Role,
  TRANSFER_MODE_LABELS,
  type DispatchListItemDto,
  type PaginatedResult,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatQty } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { usePagination } from '@/lib/use-pagination';
import { PaginationBar } from '@/components/pagination-bar';
import { RoleGate } from '@/components/role-gate';
import {
  DispatchStatusBadge,
  FiscalDocumentStatusBadge,
} from '@/components/invoicing/status-badges';
import { Badge } from '@/components/ui/badge';
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
import { cn, customerSearchHref, LINK_CLASSNAME } from '@/lib/utils';
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
 * §3.4 + D-074: despachar es un acto de **almacén**, así que planta entra acá aunque no
 * entre al resto del módulo comercial. El despacho no muestra ningún precio.
 */
const DISPATCH_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR, Role.SUPERVISOR_PLANTA] as const;

/** RF-77..RF-79: listado de despachos. */
export function DespachosView() {
  const [status, setStatus] = useState<string>(ALL);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search.trim(), 300);
  const { page, pageSize, setPage, setPageSize, resetPage } = usePagination();

  useEffect(() => {
    resetPage();
  }, [status, debouncedSearch, resetPage]);

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (status !== ALL) params.set('status', status);
  if (debouncedSearch) params.set('search', debouncedSearch);

  const dispatches = useQuery({
    queryKey: ['dispatches', page, pageSize, status, debouncedSearch],
    queryFn: () => api<PaginatedResult<DispatchListItemDto>>(`/dispatches?${params.toString()}`),
  });

  const rows = dispatches.data?.items ?? [];

  return (
    <RoleGate allow={DISPATCH_ROLES}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Despachos</h1>
          <p className="text-sm text-muted-foreground">
            El despacho saca la mercadería: mueve el kardex y cierra el pedido. Facturar no lo
            cierra.
          </p>
        </div>
        <Button asChild>
          <Link href="/despachos/nuevo">Nuevo despacho</Link>
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Buscar por cliente, placa o transportista…"
          className="max-w-sm"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los estados</SelectItem>
            {DISPATCH_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {DISPATCH_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {dispatches.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>Despacho</TableHead>
                <TableHead className="hidden md:table-cell">Pedido</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead className="hidden sm:table-cell">Fecha</TableHead>
                <TableHead className="hidden lg:table-cell">Traslado</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Peso</TableHead>
                <TableHead>Guía</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((d) => (
                <TableRow key={d.id} className={d.status === 'REVERSED' ? 'opacity-60' : undefined}>
                  <TableCell>
                    <Link href={`/despachos/${d.id}`} className={cn('font-medium', LINK_CLASSNAME)}>
                      {d.code}
                    </Link>
                    <div className="text-xs text-muted-foreground">{d.itemCount} líneas</div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Link href={`/pedidos/${d.salesOrderId}`} className={LINK_CLASSNAME}>
                      {d.salesOrderCode}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={customerSearchHref(d.customerDocNumber)} className={LINK_CLASSNAME}>
                      {d.customerName}
                    </Link>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {formatDate(d.dispatchDate)}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <div className="text-sm">{TRANSFER_MODE_LABELS[d.transferMode]}</div>
                    <div className="text-xs text-muted-foreground">
                      {d.transferMode === 'PRIVATE' ? d.vehiclePlate : d.carrierName}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-right lg:table-cell">
                    {formatQty(d.totalWeightKg, 'kg')}
                  </TableCell>
                  <TableCell>
                    {d.dispatchNoteStatus ? (
                      <div className="space-y-1">
                        <div className="text-xs">{d.dispatchNoteNumber ?? 'Borrador'}</div>
                        <FiscalDocumentStatusBadge status={d.dispatchNoteStatus} />
                      </div>
                    ) : (
                      <Badge variant="outline">Sin guía</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <DispatchStatusBadge status={d.status} />
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No hay despachos que coincidan.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
      {!dispatches.isPending && (
        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={dispatches.data?.total ?? 0}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          disabled={dispatches.isFetching}
        />
      )}
    </RoleGate>
  );
}
