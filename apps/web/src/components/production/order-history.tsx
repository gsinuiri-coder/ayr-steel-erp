'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import {
  PRODUCTION_ORDER_KIND_LABELS,
  PRODUCTION_ORDER_KINDS,
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_ORDER_STATUSES,
  toDecimal,
  type ProductionOrderDto,
  type ProductionOrderListItemDto,
} from '@ayr/shared';
import { PRODUCTION_ORDER_TONE } from '@/components/status-tone';
import { api } from '@/lib/api';
import { formatDate, formatQty } from '@/lib/format';
import { groupHistoryByOrder, type HistoryGroup } from '@/lib/order-history';
import { compareBy, compareDecimalBy, useSort } from '@/lib/use-sort';
import { URL_PAGINATION_DEFAULTS, useUrlPagination, useUrlState } from '@/lib/use-url-state';
import { PaginationBar } from '@/components/pagination-bar';
import { SortableTableHead } from '@/components/sortable-table-head';
import { StatusFilter } from '@/components/status-filter';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
import { LINK_CLASSNAME } from '@/lib/utils';

const ALL = 'ALL';
/** Tope del listado del API (`GET /production` trae las 500 órdenes más recientes). */
const LIST_CAP = 500;

/**
 * D-291: por defecto el historial no trae las anuladas (D-289: terminal negativo, chip
 * «Anuladas»). El API de producción **no** las excluye sin filtro —el detalle del pedido y la
 * cola las necesitan—, así que el historial las descarta pidiendo el resto explícitamente.
 */
const LIVE_STATUSES = PRODUCTION_ORDER_STATUSES.filter((s) => s !== 'CANCELLED');

/**
 * Historial de producción (RF-34, RF-30): **una fila por pedido** con sus órdenes adentro, de
 * las dos líneas (D-291; antes era una lista de tarjetas por pedido).
 *
 * **D-190: era la página `/produccion`** y salió de la navegación. La cola vive en `/planta`,
 * las órdenes de un pedido en su detalle, y este listado —el único lugar que mostraba las
 * cerradas, las anuladas y las corridas de drywall sin pedido, con su merma y su costo— se
 * reubicó en `/planta`. Cada fila de pedido se abre (acordeón) y lista sus órdenes con su
 * detalle auditable en `/produccion/:id`; las corridas a stock quedan en un grupo explícito.
 *
 * Un solo listado para las dos líneas de transformación (D-087): comparten tabla,
 * correlativo y estados, y para quien las administra una orden es una orden.
 *
 * Filtros, orden y página viven en la URL (D-289). El API entrega hasta {@link LIST_CAP} órdenes;
 * agrupar y paginar por pedido se hace acá sobre lo entregado.
 */
export function OrderHistory() {
  // Las claves llevan prefijo `h` para no chocar con las de la cola de planta (`?op=`).
  const [url, setUrl] = useUrlState({ ...URL_PAGINATION_DEFAULTS, hstatus: '', hkind: '' });
  const { page, pageSize, setPage, setPageSize } = useUrlPagination(url, setUrl);
  const [sort, toggleSort] = useSort<
    'order' | 'customer' | 'date' | 'closed' | 'meters' | 'status'
  >();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const statusParam = url.hstatus || LIVE_STATUSES.join(',');
  const params = new URLSearchParams({ status: statusParam });
  if (url.hkind) params.set('kind', url.hkind);
  const orders = useQuery({
    queryKey: ['production-orders', 'history', statusParam, url.hkind],
    queryFn: () => api<ProductionOrderListItemDto[]>(`/production?${params.toString()}`),
  });
  // El servidor ya entrega las OP por correlativo descendente (D-113). El primer encuentro
  // fija también el orden de los pedidos: actividad de producción más reciente primero.
  // D-323: el historial tiene todas las órdenes en el cliente (hasta el tope), así que el orden por
  // columna es sobre todos los pedidos, no solo sobre la página que se ve.
  const unsorted = groupHistoryByOrder(orders.data ?? []);
  const groups =
    sort.key === null
      ? unsorted
      : [...unsorted].sort((a, b) => {
          switch (sort.key) {
            case 'order':
              return compareBy(sort.dir, a.salesOrderCode ?? '', b.salesOrderCode ?? '');
            case 'customer':
              return compareBy(
                sort.dir,
                (a.customerName ?? '').toLowerCase(),
                (b.customerName ?? '').toLowerCase(),
              );
            case 'date':
              return compareBy(sort.dir, a.date, b.date);
            case 'closed':
              return compareBy(sort.dir, a.closedCount, b.closedCount);
            case 'meters':
              return compareDecimalBy(sort.dir, a.reportedMeters ?? '0', b.reportedMeters ?? '0');
            case 'status':
              return compareBy(sort.dir, a.status, b.status);
            default:
              return 0;
          }
        });
  // Paginación por pedido, en el cliente: el listado ya viene entero (hasta el tope).
  const pageGroups = groups.slice((page - 1) * pageSize, page * pageSize);
  const toggleOpen = (key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <StatusFilter
          value={url.hstatus}
          onChange={(v) => {
            setUrl({ hstatus: v });
          }}
          options={LIVE_STATUSES.map((s) => ({
            value: s,
            label: PRODUCTION_ORDER_STATUS_LABELS[s],
          }))}
          negativeValue="CANCELLED"
          negativeLabel="Anuladas"
          allLabel="Todas, sin anuladas"
          className="w-52"
        />
        <Select
          value={url.hkind || ALL}
          onValueChange={(v) => {
            setUrl({ hkind: v === ALL ? '' : v });
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

      {orders.isError && (
        <p className="text-sm text-destructive">No se pudieron cargar las órdenes de producción.</p>
      )}
      <div className="min-w-0 max-w-full overflow-x-auto rounded-lg border">
        <Table data-testid="order-history">
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead className="w-8" />
              <SortableTableHead
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
                active={sort.key === 'date'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('date');
                }}
              >
                Fecha
              </SortableTableHead>
              <SortableTableHead
                active={sort.key === 'closed'}
                dir={sort.dir}
                align="right"
                className="text-right"
                onClick={() => {
                  toggleSort('closed');
                }}
              >
                Órdenes cerradas
              </SortableTableHead>
              <SortableTableHead
                active={sort.key === 'meters'}
                dir={sort.dir}
                align="right"
                className="text-right"
                onClick={() => {
                  toggleSort('meters');
                }}
              >
                ML reportado / plan
              </SortableTableHead>
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
            {orders.isPending && (
              <TableRow>
                <TableCell colSpan={7}>
                  <Skeleton className="h-5 w-full" />
                </TableCell>
              </TableRow>
            )}
            {pageGroups.map((group) => (
              <HistoryRow
                key={group.key}
                group={group}
                expanded={open.has(group.key)}
                onToggle={() => {
                  toggleOpen(group.key);
                }}
              />
            ))}
            {orders.isSuccess && groups.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  No hay órdenes de producción que coincidan con el filtro.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={groups.length}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={orders.isFetching}
      />
      {(orders.data?.length ?? 0) >= LIST_CAP && (
        <p className="text-xs text-muted-foreground">
          Se muestran las {LIST_CAP} órdenes más recientes; afina con los filtros para ver otras.
        </p>
      )}
    </div>
  );
}

/** Una fila de pedido y, si está abierta, la tabla de sus órdenes. */
function HistoryRow({
  group,
  expanded,
  onToggle,
}: {
  group: HistoryGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  const label = group.salesOrderCode ?? 'Corridas sin pedido';
  return (
    <Fragment>
      <TableRow data-testid="history-order-row" data-state={expanded ? 'open' : 'closed'}>
        <TableCell className="w-8 pr-0">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Ocultar' : 'Ver'} las órdenes de ${label}`}
            className="inline-flex size-6 items-center justify-center rounded-sm hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            onClick={onToggle}
          >
            <ChevronRight
              aria-hidden
              className={`size-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
          </button>
        </TableCell>
        <TableCell className="font-medium">
          {group.salesOrderId === null ? (
            <span>Corridas sin pedido</span>
          ) : (
            <Link href={`/pedidos/${group.salesOrderId}`} className={LINK_CLASSNAME}>
              {group.salesOrderCode}
            </Link>
          )}
        </TableCell>
        <TableCell className="text-muted-foreground">{group.customerName ?? '—'}</TableCell>
        <TableCell className="whitespace-nowrap">{formatDate(group.date)}</TableCell>
        <TableCell className="text-right tabular-nums">
          {group.closedCount} / {group.orders.length}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {group.planMeters === null
            ? '—'
            : `${formatQty(group.reportedMeters ?? '0.000', 'm')} / ${formatQty(group.planMeters, 'm')}`}
        </TableCell>
        <TableCell>
          <Badge variant={PRODUCTION_ORDER_TONE[group.status]}>
            {PRODUCTION_ORDER_STATUS_LABELS[group.status]}
          </Badge>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow data-testid="history-orders-detail" className="bg-muted/30 hover:bg-muted/30">
          <TableCell />
          <TableCell colSpan={6} className="max-w-0 py-2">
            <div className="min-w-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Orden</TableHead>
                    <TableHead>Producto</TableHead>
                    <TableHead className="text-right">Producido</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Bobinas usadas</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.orders.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell>
                        <Link
                          href={`/produccion/${o.id}`}
                          className={`font-mono font-medium ${LINK_CLASSNAME}`}
                        >
                          {o.code}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {o.productSku} · {o.productName}
                        <div className="text-xs text-muted-foreground">
                          {PRODUCTION_ORDER_KIND_LABELS[o.kind]}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{producedLabel(o)}</TableCell>
                      <TableCell>
                        <Badge variant={PRODUCTION_ORDER_TONE[o.status]}>
                          {PRODUCTION_ORDER_STATUS_LABELS[o.status]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <UsedCoils order={o} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

/**
 * Las bobinas de las que salió el material de la orden: las de sus reportes vivos (D-291),
 * pedidas al detalle solo cuando la fila se abre (`GET /production/:id`, la misma consulta que
 * el detalle de la orden, así que su caché se comparte). Sin reportes, las que tiene montadas.
 */
function UsedCoils({ order }: { order: ProductionOrderListItemDto }) {
  const detail = useQuery({
    queryKey: ['production-order', order.id],
    queryFn: () => api<ProductionOrderDto>(`/production/${order.id}`),
  });
  if (detail.isPending) return <Skeleton className="h-4 w-24" />;
  const used = new Map<string, { id: string; code: string; kg: string }>();
  for (const report of detail.data?.reports ?? []) {
    for (const c of report.coils) {
      const prev = used.get(c.id);
      used.set(c.id, {
        ...c,
        kg: prev ? toDecimal(prev.kg).plus(toDecimal(c.kg)).toFixed(3) : c.kg,
      });
    }
  }
  const coils = [...used.values()];
  if (coils.length === 0) {
    if (order.mountedCoilCodes.length === 0)
      return <span className="text-muted-foreground">—</span>;
    const shown = order.mountedCoilCodes.slice(0, MAX_INLINE_COILS);
    const rest = order.mountedCoilCodes.slice(MAX_INLINE_COILS);
    return (
      <span className="text-muted-foreground">
        {shown.join(', ')}
        {rest.length > 0 && (
          <CoilOverflow
            count={rest.length}
            items={rest.map((code) => ({ key: code, label: code, href: null, kg: null }))}
          />
        )}{' '}
        <span className="text-xs">(montadas)</span>
      </span>
    );
  }
  const shown = coils.slice(0, MAX_INLINE_COILS);
  const rest = coils.slice(MAX_INLINE_COILS);
  return (
    <span data-testid="used-coils">
      {shown.map((c, i) => (
        <span key={c.id} className="whitespace-nowrap">
          {i > 0 && ', '}
          <Link href={`/bobinas/${c.id}`} className={LINK_CLASSNAME}>
            {c.code}
          </Link>
        </span>
      ))}
      {rest.length > 0 && (
        <CoilOverflow
          count={rest.length}
          items={rest.map((c) => ({
            key: c.id,
            label: c.code,
            href: `/bobinas/${c.id}`,
            kg: c.kg,
          }))}
        />
      )}
    </span>
  );
}

/** D-324: cuántos códigos de bobina caben en la fila; el resto va en un popover «+N». */
const MAX_INLINE_COILS = 2;

/**
 * D-324: el resto de las bobinas de una orden. Un pedido con muchas bobinas hacía crecer la fila
 * expandida del historial y, con ella, el ancho de toda la página (scroll horizontal): la lista
 * larga vive en un popover y la fila queda del mismo tamaño con dos bobinas o con cincuenta.
 */
function CoilOverflow({
  count,
  items,
}: {
  count: number;
  items: { key: string; label: string; href: string | null; kg: string | null }[];
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Ver las ${String(count)} bobinas restantes`}
        className="ml-1 rounded-sm border px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        +{count}
      </PopoverTrigger>
      <PopoverContent className="max-h-72 w-auto min-w-48 overflow-y-auto">
        <ul className="grid gap-1 text-sm" data-testid="used-coils-more">
          {items.map((c) => (
            <li key={c.key} className="flex items-baseline justify-between gap-4">
              {c.href ? (
                <Link href={c.href} className={LINK_CLASSNAME}>
                  {c.label}
                </Link>
              ) : (
                <span>{c.label}</span>
              )}
              {c.kg !== null && (
                <span className="tabular-nums text-muted-foreground">{formatQty(c.kg, 'kg')}</span>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function producedLabel(order: ProductionOrderListItemDto): string {
  if (order.metersReported === null) {
    return order.targetPieces === null
      ? `${String(order.piecesReported)} pzs`
      : `${String(order.piecesReported)} / ${String(order.targetPieces)} pzs`;
  }
  return order.planMeters === null
    ? `${formatQty(order.metersReported, 'm')} · ${String(order.piecesReported)} pzs`
    : `${formatQty(order.metersReported, 'm')} / ${formatQty(order.planMeters, 'm')}`;
}
