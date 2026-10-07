'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Decimal,
  ORDER_STAGE_LABELS,
  Role,
  type PaginatedResult,
  type SalesOrderListItemDto,
  type SalesOrderQuery,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { listXlsxHref } from '@/lib/list-export';
import { HeaderActions } from '@/components/header-actions';
import { currencyHeader, formatAmount, formatDate } from '@/lib/format';
import { ListFooterRow } from '@/components/list-footer';
import { ListStateRows } from '@/components/list-state';
import { RoleGate } from '@/components/role-gate';
import { OrderDocumentLinks } from '@/components/sales/order-documents';
import { OrderStageBadge } from '@/components/sales/status-badges';
import {
  URL_PAGINATION_DEFAULTS,
  useUrlPagination,
  useUrlSearchInput,
  useUrlState,
} from '@/lib/use-url-state';
import { FilterChip } from '@/components/filter-chip';
import { Input } from '@/components/ui/input';
import { PaginationBar } from '@/components/pagination-bar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  cn,
  customerSearchHref,
  CUSTOMER_CELL_CLASSNAME,
  CUSTOMER_NAME_CLASSNAME,
  LINK_CLASSNAME,
} from '@/lib/utils';
import { compareBy, useSort } from '@/lib/use-sort';
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

/** D-323: las columnas que ordena el servidor, más `status` (el estado mostrado, de la página). */
type OrderSortKey = NonNullable<SalesOrderQuery['sort']> | 'status';

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
    // Sobre la URL más reciente, no sobre lo pintado: dos chips pulsados seguidos no se pisan.
    setUrl((cur) => {
      const now = cur.stage.split(',').filter(Boolean);
      const chipsOnly = now.length > 0 && now.every((s) => s === 'FULFILLED' || s === 'CANCELLED');
      const base = chipsOnly ? now : [];
      const next = base.includes(stage) ? base.filter((s) => s !== stage) : [...base, stage];
      return { stage: next.join(',') };
    });
  };

  // Sin estado elegido: los activos; y buscando, todos (quien pega `PED-000123` lo quiere
  // esté como esté).
  const stageParam = stages.length > 0 ? stages.join(',') : search ? '' : ACTIVE_STAGES.join(',');

  const [sort, toggleSort] = useSort<OrderSortKey>();
  const serverSort = sort.key !== null && sort.key !== 'status' ? sort.key : null;

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (stageParam) params.set('stage', stageParam);
  if (search) params.set('search', search);
  if (serverSort) {
    params.set('sort', serverSort);
    params.set('dir', sort.dir);
  }

  const orders = useQuery({
    queryKey: ['sales-orders', page, pageSize, stageParam, search, serverSort, sort.dir],
    queryFn: () =>
      api<PaginatedResult<SalesOrderListItemDto>>(`/sales/orders?${params.toString()}`),
  });

  // D-323: código, cliente, fecha y total se ordenan en el servidor; el estado que se muestra es
  // derivado (etapa de producción y despacho) y solo se ordena entre las filas de la página.
  const rawRows = orders.data?.items ?? [];
  const rows =
    sort.key === 'status'
      ? [...rawRows].sort((x, y) => compareBy(sort.dir, x.stage, y.stage))
      : rawRows;

  // cc31: el filtro activo acompaña al título y al pie («4 de 38 pedidos en curso»).
  let filterLabel = 'en curso';
  if (historyOnly) {
    filterLabel = stages.map((s) => (s === 'FULFILLED' ? 'atendidos' : 'anulados')).join(' y ');
  } else if (stages.length === 1 && stages[0]) {
    filterLabel = `en «${ORDER_STAGE_LABELS[stages[0] as keyof typeof ORDER_STAGE_LABELS]}»`;
  } else if (search) {
    filterLabel = 'que coinciden con la búsqueda';
  }
  const pageTotal = rows.reduce((acc, o) => acc.plus(o.totalPen), new Decimal(0));

  return (
    <RoleGate allow={SALES_ROLES}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-semibold">Pedidos</h1>
            <span className="text-muted-foreground">{filterLabel}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Nacen de confirmar una cotización, o directo en las líneas que no la exigen.
          </p>
        </div>
        {/* cc31: «Más opciones» (el Excel) y un solo botón principal. cc26 M2: el Excel lleva los
            filtros y el orden de la lista (todas las páginas); el orden por estado es solo de la
            página y no viaja. */}
        <HeaderActions
          primary={['new']}
          actions={[
            { key: 'new', label: 'Nuevo pedido directo', href: '/pedidos/nuevo' },
            {
              key: 'xlsx',
              label: 'Descargar Excel',
              download: listXlsxHref('/sales/orders', params),
            },
          ]}
        />
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
              {/* Correcciones 05 / M4: comprobantes vivos (factura, boleta, NC). */}
              <TableHead className="hidden md:table-cell">Comprobante</TableHead>
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
                {currencyHeader('Total')}
              </SortableTableHead>
              <TableHead className="hidden text-right lg:table-cell">Reservas activas</TableHead>
              <SortableTableHead
                active={sort.key === 'status'}
                dir={sort.dir}
                title="Ordena las filas de esta página"
                onClick={() => {
                  toggleSort('status');
                }}
              >
                Estado
              </SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
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
                <TableCell className="hidden md:table-cell">
                  {(o.documents?.length ?? 0) > 0 ? (
                    <OrderDocumentLinks documents={o.documents ?? []} />
                  ) : (
                    <span className="text-muted-foreground">Sin emitir</span>
                  )}
                </TableCell>
                <TableCell className="hidden sm:table-cell">{formatDate(o.issueDate)}</TableCell>
                <TableCell className="text-right">{formatAmount(o.totalPen)}</TableCell>
                <TableCell className="hidden text-right lg:table-cell">
                  {o.activeReservations}
                </TableCell>
                <TableCell>
                  <OrderStageBadge stage={o.stage} />
                </TableCell>
              </TableRow>
            ))}
            <ListStateRows
              query={orders}
              colSpan={8}
              isEmpty={rows.length === 0}
              filtered={Boolean(search) || stages.length > 0}
              emptyTitle="Todavía no hay pedidos en curso"
              emptyHint="Un pedido nace al confirmar una cotización, o directo con «Nuevo pedido directo»."
              noResultsTitle={
                search ? `Ningún pedido coincide con «${search}»` : 'Ningún pedido con este filtro'
              }
              onClearFilters={() => {
                setSearchText('');
                setUrl({ search: '', stage: '' });
              }}
              errorTitle="No se pudieron cargar los pedidos"
            />
          </TableBody>
          {rows.length > 0 && (
            <ListFooterRow
              shown={rows.length}
              total={orders.data?.total ?? rows.length}
              noun={`pedidos ${filterLabel}`}
              colCount={8}
              amountColumn={5}
              amount={formatAmount(pageTotal)}
            />
          )}
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
