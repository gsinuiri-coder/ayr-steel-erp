'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  DISPATCH_STATUS_LABELS,
  DISPATCH_STATUSES,
  Role,
  TRANSFER_MODE_LABELS,
  type DispatchListItemDto,
  type PaginatedResult,
  type DispatchQuery,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatQty } from '@/lib/format';
import {
  URL_PAGINATION_DEFAULTS,
  useUrlPagination,
  useUrlSearchInput,
  useUrlState,
} from '@/lib/use-url-state';
import { StatusFilter } from '@/components/status-filter';
import { PaginationBar } from '@/components/pagination-bar';
import { RoleGate } from '@/components/role-gate';
import {
  DispatchStatusBadge,
  FiscalDocumentStatusBadge,
} from '@/components/invoicing/status-badges';
import { HeaderActions } from '@/components/header-actions';
import { ListFooterRow } from '@/components/list-footer';
import { ListStateRows } from '@/components/list-state';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn, customerSearchHref, LINK_CLASSNAME } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortableTableHead } from '@/components/sortable-table-head';
import { useSort } from '@/lib/use-sort';

/**
 * §3.4 + D-074: despachar es un acto de **almacén**, así que planta entra acá aunque no
 * entre al resto del módulo comercial. El despacho no muestra ningún precio.
 */
const DISPATCH_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR, Role.SUPERVISOR_PLANTA] as const;

/** RF-77..RF-79: listado de despachos. */
export function DespachosView() {
  // D-289: filtros, búsqueda y página viven en la URL.
  const [url, setUrl] = useUrlState({ ...URL_PAGINATION_DEFAULTS, search: '', status: '' });
  const { page, pageSize, setPage, setPageSize } = useUrlPagination(url, setUrl);
  const [searchText, setSearchText, search] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });
  const status = url.status;

  // D-323: el orden por columna es del servidor (todas estas columnas son de la propia fila).
  const [sort, toggleSort] = useSort<NonNullable<DispatchQuery['sort']>>();

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (status) params.set('status', status);
  if (search) params.set('search', search);
  if (sort.key) {
    params.set('sort', sort.key);
    params.set('dir', sort.dir);
  }

  const dispatches = useQuery({
    queryKey: ['dispatches', page, pageSize, status, search, sort.key, sort.dir],
    queryFn: () => api<PaginatedResult<DispatchListItemDto>>(`/dispatches?${params.toString()}`),
  });

  const rows = dispatches.data?.items ?? [];

  // cc31: el filtro activo acompaña al título y al pie («4 de 38 despachos revertidos»).
  let filterLabel = '';
  if (status === 'REVERSED') {
    filterLabel = 'revertidos';
  } else if (status) {
    filterLabel = `en «${DISPATCH_STATUS_LABELS[status as keyof typeof DISPATCH_STATUS_LABELS]}»`;
  } else if (search) {
    filterLabel = 'que coinciden con la búsqueda';
  }

  return (
    <RoleGate allow={DISPATCH_ROLES}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-semibold">Despachos</h1>
            {filterLabel && <span className="text-muted-foreground">{filterLabel}</span>}
          </div>
          <p className="text-xs text-muted-foreground">
            El despacho saca la mercadería: mueve el kardex y cierra el pedido. Facturar no lo
            cierra.
          </p>
        </div>
        <HeaderActions
          primary={['new']}
          actions={[{ key: 'new', label: 'Nuevo despacho', href: '/despachos/nuevo' }]}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Buscar por cliente, placa o transportista…"
          className="max-w-sm"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
          }}
        />
        <StatusFilter
          value={status}
          onChange={(v) => {
            setUrl({ status: v });
          }}
          options={DISPATCH_STATUSES.filter((s) => s !== 'REVERSED').map((s) => ({
            value: s,
            label: DISPATCH_STATUS_LABELS[s],
          }))}
          negativeValue="REVERSED"
          negativeLabel="Revertidos"
          allLabel="Todos, sin revertidos"
          className="w-52"
        />
      </div>

      <div className="rounded-lg border">
        <Table list>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <SortableTableHead
                active={sort.key === 'code'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('code');
                }}
              >
                Despacho
              </SortableTableHead>
              <SortableTableHead
                className="hidden md:table-cell"
                active={sort.key === 'order'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('order');
                }}
              >
                Pedido
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
              <SortableTableHead
                className="hidden sm:table-cell"
                active={sort.key === 'date'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('date');
                }}
              >
                Fecha
              </SortableTableHead>
              <TableHead className="hidden lg:table-cell">Traslado</TableHead>
              <SortableTableHead
                className="hidden text-right lg:table-cell"
                align="right"
                active={sort.key === 'weight'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('weight');
                }}
              >
                Peso
              </SortableTableHead>
              <TableHead>Guía</TableHead>
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
                <TableCell className="hidden sm:table-cell">{formatDate(d.dispatchDate)}</TableCell>
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
            <ListStateRows
              query={dispatches}
              colSpan={8}
              isEmpty={rows.length === 0}
              filtered={Boolean(search) || Boolean(status)}
              emptyTitle="Todavía no hay despachos"
              emptyHint="Un despacho saca la mercadería de un pedido: créalo con «Nuevo despacho»."
              noResultsTitle={
                search
                  ? `Ningún despacho coincide con «${search}»`
                  : 'Ningún despacho con este filtro'
              }
              onClearFilters={() => {
                setSearchText('');
                setUrl({ search: '', status: '' });
              }}
              errorTitle="No se pudieron cargar los despachos"
            />
          </TableBody>
          {rows.length > 0 && (
            <ListFooterRow
              shown={rows.length}
              total={dispatches.data?.total ?? rows.length}
              noun={filterLabel ? `despachos ${filterLabel}` : 'despachos'}
              colCount={8}
            />
          )}
        </Table>
      </div>
      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={dispatches.data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={dispatches.isFetching}
      />
    </RoleGate>
  );
}
