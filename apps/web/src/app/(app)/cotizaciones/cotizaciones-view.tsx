'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Decimal,
  QUOTATION_STATUS_LABELS,
  QUOTATION_STATUSES,
  Role,
  type PaginatedResult,
  type QuotationListItemDto,
  type QuotationQuery,
} from '@ayr/shared';

type QuotationSortKey = NonNullable<QuotationQuery['sort']>;
import { api } from '@/lib/api';
import { listXlsxHref } from '@/lib/list-export';
import { HeaderActions } from '@/components/header-actions';
import { currencyHeader, formatAmount, formatDate } from '@/lib/format';
import { ListFooterRow } from '@/components/list-footer';
import { ListStateRows } from '@/components/list-state';
import { RoleGate } from '@/components/role-gate';
import { useSession } from '@/lib/session';
import { QuotationStatusBadge } from '@/components/sales/status-badges';
import { QuotationInvoice } from '@/components/sales/quotation-invoice';
import {
  URL_PAGINATION_DEFAULTS,
  useUrlPagination,
  useUrlSearchInput,
  useUrlState,
} from '@/lib/use-url-state';
import { StatusFilter } from '@/components/status-filter';
import { PaginationBar } from '@/components/pagination-bar';
import { Input } from '@/components/ui/input';
import {
  cn,
  customerSearchHref,
  CUSTOMER_CELL_CLASSNAME,
  CUSTOMER_NAME_CLASSNAME,
  LINK_CLASSNAME,
} from '@/lib/utils';
import { useSort } from '@/lib/use-sort';
import { SortableTableHead } from '@/components/sortable-table-head';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** §3.4: el módulo comercial es de ADMINISTRADOR y VENDEDOR. */
const SALES_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

/** RF-61/RF-69: listado de cotizaciones. */
export function CotizacionesView() {
  const { user } = useSession();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  // D-289: filtros, búsqueda y página viven en la URL.
  const [url, setUrl] = useUrlState({ ...URL_PAGINATION_DEFAULTS, search: '', status: '' });
  const { page, pageSize, setPage, setPageSize } = useUrlPagination(url, setUrl);
  // La búsqueda va al API (RF-84) para que una cotización fuera de la página actual se
  // pueda encontrar: por nombre/documento del cliente, por código (extrae el número de
  // "COT-…") o por el comprobante de una importada (D-387).
  const [searchText, setSearchText, search] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });
  const status = url.status;

  // D-323: el orden por columna es del servidor. D-387: «Comprobante» lo ordena el API leyendo la
  // marca del importador.
  const [sort, toggleSort] = useSort<QuotationSortKey>();

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (status) params.set('status', status);
  if (search) params.set('search', search);
  if (sort.key) {
    params.set('sort', sort.key);
    params.set('dir', sort.dir);
  }

  const quotations = useQuery({
    queryKey: ['quotations', page, pageSize, status, search, sort.key, sort.dir],
    queryFn: () =>
      api<PaginatedResult<QuotationListItemDto>>(`/sales/quotations?${params.toString()}`),
  });

  const rows = quotations.data?.items ?? [];

  // cc31: el filtro activo acompaña al título y al pie («4 de 38 cotizaciones anuladas»).
  let filterLabel = '';
  if (status === 'CANCELLED') {
    filterLabel = 'anuladas';
  } else if (status) {
    const label = QUOTATION_STATUS_LABELS[status as keyof typeof QUOTATION_STATUS_LABELS];
    filterLabel = `en «${label}»`;
  } else if (search) {
    filterLabel = 'que coinciden con la búsqueda';
  }
  const pageTotal = rows.reduce((acc, q) => acc.plus(q.totalPen), new Decimal(0));

  return (
    <RoleGate allow={SALES_ROLES}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-semibold">Cotizaciones</h1>
            {filterLabel && <span className="text-muted-foreground">{filterLabel}</span>}
          </div>
          <p className="text-xs text-muted-foreground">
            Cotizar no reserva stock; confirmar crea el pedido y la reserva.
          </p>
        </div>
        {/* cc31: un solo botón principal y lo demás en «Más opciones». cc26: el Excel lleva los
            filtros y el orden de la lista (todas las páginas). D-152: la carga histórica entra
            por «Importar desde Excel» y termina en cotizaciones en borrador. */}
        <HeaderActions
          primary={['new']}
          actions={[
            { key: 'new', label: 'Nueva cotización', href: '/cotizaciones/nueva' },
            {
              key: 'xlsx',
              label: 'Descargar Excel',
              download: listXlsxHref('/sales/quotations', params),
            },
            {
              key: 'import',
              label: 'Importar desde Excel',
              href: '/cotizaciones/importar',
              show: isAdmin,
            },
          ]}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Buscar por código, comprobante, cliente o documento…"
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
          options={QUOTATION_STATUSES.filter((s) => s !== 'CANCELLED').map((s) => ({
            value: s,
            label: QUOTATION_STATUS_LABELS[s],
          }))}
          negativeValue="CANCELLED"
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
                Código
              </SortableTableHead>
              {/* D-387: la factura de papel de las importadas; vacía en las demás. */}
              <SortableTableHead
                active={sort.key === 'invoice'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('invoice');
                }}
              >
                Comprobante
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
                {currencyHeader('Total')}
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
            {rows.map((q) => (
              <TableRow key={q.id}>
                <TableCell className="font-medium">
                  <Link href={`/cotizaciones/${q.id}`} className={LINK_CLASSNAME}>
                    {q.code}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-nowrap" data-testid="quotation-invoice-cell">
                  <QuotationInvoice
                    externalInvoice={q.externalInvoice}
                    invoiceDocuments={q.invoiceDocuments}
                  />
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
                <TableCell className="text-right">{formatAmount(q.totalPen)}</TableCell>
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
            <ListStateRows
              query={quotations}
              colSpan={8}
              isEmpty={rows.length === 0}
              filtered={Boolean(search) || Boolean(status)}
              emptyTitle="Todavía no hay cotizaciones"
              emptyHint="Crea la primera con «Nueva cotización»."
              noResultsTitle={
                search
                  ? `Ninguna cotización coincide con «${search}»`
                  : 'Ninguna cotización con este filtro'
              }
              onClearFilters={() => {
                setSearchText('');
                setUrl({ search: '', status: '' });
              }}
              errorTitle="No se pudieron cargar las cotizaciones"
            />
          </TableBody>
          {rows.length > 0 && (
            <ListFooterRow
              shown={rows.length}
              total={quotations.data?.total ?? rows.length}
              noun={filterLabel ? `cotizaciones ${filterLabel}` : 'cotizaciones'}
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
        total={quotations.data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={quotations.isFetching}
      />
    </RoleGate>
  );
}
