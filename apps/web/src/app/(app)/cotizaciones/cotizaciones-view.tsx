'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  QUOTATION_STATUS_LABELS,
  QUOTATION_STATUSES,
  Role,
  type PaginatedResult,
  type QuotationListItemDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { RoleGate } from '@/components/role-gate';
import { useSession } from '@/lib/session';
import { QuotationStatusBadge } from '@/components/sales/status-badges';
import { useDebounced } from '@/lib/use-debounced';
import { usePagination } from '@/lib/use-pagination';
import { PaginationBar } from '@/components/pagination-bar';
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

/** RF-61/RF-69: listado de cotizaciones. */
export function CotizacionesView() {
  const { user } = useSession();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const [status, setStatus] = useState<string>(ALL);
  const [search, setSearch] = useState('');
  // La búsqueda va al API (RF-84) para que una cotización fuera de la página actual se
  // pueda encontrar: por nombre/documento del cliente, o por código (extrae el número de
  // "COT-…").
  const debouncedSearch = useDebounced(search.trim(), 300);
  const { page, pageSize, setPage, setPageSize, resetPage } = usePagination();

  useEffect(() => {
    resetPage();
  }, [status, debouncedSearch, resetPage]);

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (status !== ALL) params.set('status', status);
  if (debouncedSearch) params.set('search', debouncedSearch);

  const quotations = useQuery({
    queryKey: ['quotations', page, pageSize, status, debouncedSearch],
    queryFn: () =>
      api<PaginatedResult<QuotationListItemDto>>(`/sales/quotations?${params.toString()}`),
  });

  // S10b/M1: sort sobre la página actual, no sobre el total (D-176 del handoff de S10:
  // el orden por defecto del servidor —descendente— no se toca, esto solo se activa si
  // el usuario clickea una columna).
  const [sort, toggleSort] = useSort<'code' | 'customer' | 'issueDate' | 'total' | 'status'>();
  const unsortedRows = quotations.data?.items ?? [];
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
          <h1 className="text-lg font-semibold">Cotizaciones</h1>
          <p className="text-xs text-muted-foreground">
            Cotizar no reserva stock; confirmar crea el pedido y la reserva (RF-61, RF-62).
          </p>
        </div>
        <div className="flex gap-2">
          {/* D-152: la carga histórica entra por acá y termina en cotizaciones en borrador. */}
          {isAdmin && (
            <Button variant="outline" asChild>
              <Link href="/cotizaciones/importar">Importar desde Excel</Link>
            </Button>
          )}
          <Button asChild>
            <Link href="/cotizaciones/nueva">Nueva cotización</Link>
          </Button>
        </div>
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
            {QUOTATION_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {QUOTATION_STATUS_LABELS[s]}
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
              <SortableTableHead
                active={sort.key === 'issueDate'}
                dir={sort.dir}
                className="hidden sm:table-cell"
                onClick={() => {
                  toggleSort('issueDate');
                }}
              >
                Emisión
              </SortableTableHead>
              <TableHead className="hidden md:table-cell">Vigencia</TableHead>
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
              <SortableTableHead
                active={sort.key === 'status'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('status');
                }}
              >
                Estado
              </SortableTableHead>
              <TableHead className="hidden lg:table-cell">Pedido</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {quotations.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {quotations.isError && (
              <TableRow>
                <TableCell colSpan={7} className="text-destructive">
                  No se pudieron cargar las cotizaciones.
                </TableCell>
              </TableRow>
            )}
            {rows.map((q) => (
              <TableRow key={q.id}>
                <TableCell className="font-medium">
                  <Link href={`/cotizaciones/${q.id}`} className={LINK_CLASSNAME}>
                    {q.code}
                  </Link>
                </TableCell>
                <TableCell className={CUSTOMER_CELL_CLASSNAME}>
                  <Link
                    href={customerSearchHref(q.customerDocNumber)}
                    className={cn(LINK_CLASSNAME, CUSTOMER_NAME_CLASSNAME)}
                    title={q.customerName}
                  >
                    {q.customerName}
                  </Link>
                  <span className="ml-2 text-xs text-muted-foreground">{q.customerDocNumber}</span>
                </TableCell>
                <TableCell className="hidden sm:table-cell">{formatDate(q.issueDate)}</TableCell>
                {/* D-157: `null` es "no vence", no "falta el dato". */}
                <TableCell className="hidden md:table-cell">
                  {q.validUntil === null ? 'Sin vencimiento' : formatDate(q.validUntil)}
                </TableCell>
                <TableCell className="text-right">{formatMoney(q.totalPen)}</TableCell>
                <TableCell>
                  {<QuotationStatusBadge status={q.status} isExpired={q.isExpired} />}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  {q.salesOrderId ? (
                    <Link href={`/pedidos/${q.salesOrderId}`} className={LINK_CLASSNAME}>
                      {q.salesOrderCode}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {quotations.isSuccess && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  {search || status !== ALL
                    ? 'Ninguna cotización coincide con el filtro.'
                    : 'No hay cotizaciones todavía.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={quotations.data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={quotations.isFetching}
      />
    </RoleGate>
  );
}
