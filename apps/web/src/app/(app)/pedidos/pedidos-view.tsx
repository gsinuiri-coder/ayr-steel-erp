'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  ORDER_STAGE_LABELS,
  Role,
  type PaginatedResult,
  type SalesOrderListItemDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { RoleGate } from '@/components/role-gate';
import { OrderStageBadge } from '@/components/sales/status-badges';
import {
  URL_PAGINATION_DEFAULTS,
  useUrlPagination,
  useUrlSearchInput,
  useUrlState,
} from '@/lib/use-url-state';
import { FilterChip } from '@/components/filter-chip';
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
import {
  cn,
  customerSearchHref,
  CUSTOMER_CELL_CLASSNAME,
  CUSTOMER_NAME_CLASSNAME,
  LINK_CLASSNAME,
} from '@/lib/utils';
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

/**
 * D-289: la bandeja de pedidos muestra por defecto los que siguen vivos. «Atendidos»
 * (FULFILLED) y «Anulados» (CANCELLED) son historia y se piden con su chip; con chip activo
 * la lista muestra **solo** esos.
 */
const ACTIVE_STAGES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTIALLY_FULFILLED'] as const;

/** Pedidos (D-065). La reserva viva es lo que hace que el pedido signifique algo. */
export function PedidosView() {
  // D-289: filtros, búsqueda y página viven en la URL. `stage` es una lista separada por comas.
  const [url, setUrl] = useUrlState({ ...URL_PAGINATION_DEFAULTS, search: '', stage: '' });
  const { page, pageSize, setPage, setPageSize } = useUrlPagination(url, setUrl);
  // La búsqueda va al API (RF-84) para que un pedido fuera de la página actual se pueda
  // encontrar: por nombre/documento del cliente, o por código (extrae el número de "PED-…").
  const [searchText, setSearchText, search] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });

  const stages = url.stage.split(',').filter(Boolean);
  const historyOnly =
    stages.length > 0 && stages.every((s) => s === 'FULFILLED' || s === 'CANCELLED');
  const selectValue = stages.length === 1 && !historyOnly ? (stages[0] ?? ALL) : ALL;
  const toggleChip = (stage: 'FULFILLED' | 'CANCELLED') => {
    const current = historyOnly ? stages : [];
    const next = current.includes(stage) ? current.filter((s) => s !== stage) : [...current, stage];
    setUrl({ stage: next.join(',') });
  };

  // Sin estado elegido: los activos; y buscando, todos (quien pega `PED-000123` lo quiere
  // esté como esté).
  const stageParam = stages.length > 0 ? stages.join(',') : search ? '' : ACTIVE_STAGES.join(',');

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (stageParam) params.set('stage', stageParam);
  if (search) params.set('search', search);

  const orders = useQuery({
    queryKey: ['sales-orders', page, pageSize, stageParam, search],
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
              return compareBy(sort.dir, a.stage, b.stage);
            default:
              return 0;
          }
        });

  return (
    <RoleGate allow={SALES_ROLES}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Pedidos</h1>
          <p className="text-xs text-muted-foreground">
            Nacen de confirmar una cotización, o directo en las líneas que no la exigen (D-065).
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/pedidos/nuevo">Nuevo pedido directo</Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Buscar por código, cliente o documento…"
          className="max-w-sm"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
          }}
        />
        <Select
          value={selectValue}
          onValueChange={(v) => {
            setUrl({ stage: v === ALL ? '' : v });
          }}
        >
          <SelectTrigger className="w-56" aria-label="Estado">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Pedidos en curso</SelectItem>
            {ACTIVE_STAGES.map((s) => (
              <SelectItem key={s} value={s}>
                {ORDER_STAGE_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FilterChip
          active={stages.includes('FULFILLED')}
          onToggle={() => {
            toggleChip('FULFILLED');
          }}
        >
          Atendidos
        </FilterChip>
        <FilterChip
          active={stages.includes('CANCELLED')}
          onToggle={() => {
            toggleChip('CANCELLED');
          }}
        >
          Anulados
        </FilterChip>
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
                <TableCell className={CUSTOMER_CELL_CLASSNAME}>
                  <Link
                    href={customerSearchHref(o.customerDocNumber)}
                    className={cn(LINK_CLASSNAME, CUSTOMER_NAME_CLASSNAME)}
                    title={o.customerName}
                  >
                    {o.customerName}
                  </Link>
                  <span className="ml-2 text-xs text-muted-foreground">{o.customerDocNumber}</span>
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
                  <OrderStageBadge stage={o.stage} />
                </TableCell>
              </TableRow>
            ))}
            {orders.isSuccess && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  {search || stages.length > 0
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
