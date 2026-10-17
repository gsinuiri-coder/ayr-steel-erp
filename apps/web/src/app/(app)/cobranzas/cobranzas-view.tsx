'use client';

import { DocumentFilterFields } from '@/components/invoicing/document-filter-fields';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  DEFAULT_PAGE_SIZE,
  FISCAL_DOC_TYPE_LABELS,
  Role,
  toDecimal,
  type FiscalDocumentListItemDto,
  type PaginatedResult,
  type ReceivableSummaryDto,
  type ReceivableTotalsDto,
  CREDIT_WITHOUT_DUE_LABEL,
  noDueDateLabel,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { listXlsxHref } from '@/lib/list-export';
import { useSession } from '@/lib/session';
import { HeaderActions } from '@/components/header-actions';
import { formatDate, formatMoney } from '@/lib/format';
import { useUrlSearchInput, useUrlState } from '@/lib/use-url-state';
import { useUrlTab } from '@/lib/use-url-tab';
import { PaginationBar } from '@/components/pagination-bar';
import { Stat, StatStrip } from '@/components/stat-strip';
import { RoleGate } from '@/components/role-gate';
import { ListStateRows } from '@/components/list-state';
import { FiltersDialog, TableToolbar, ToolbarSearch } from '@/components/table-toolbar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  cn,
  customerSearchHref,
  CUSTOMER_CELL_CLASSNAME,
  CUSTOMER_NAME_CLASSNAME,
  LINK_CLASSNAME,
} from '@/lib/utils';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { SortHead } from '@/components/sortable-table-head';
import { sortRows } from '@/lib/sort-rows';
import { useSort } from '@/lib/use-sort';

const SALES_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

/**
 * RF-88: cuentas por cobrar.
 *
 * Dos vistas del mismo hecho: el resumen por cliente —para saber a quién llamar— y el
 * detalle por comprobante, que es donde se cobra (D-075: el cobro va contra el
 * comprobante, no contra el pedido).
 *
 * cc47 (D-617): una tabla principal por página. Las dos vistas van cada una en su pestaña, con la
 * pestaña en la URL (`?tab=pendientes`), y cada pestaña lleva su línea estándar (D-615).
 */
/** D-323: las columnas de «Pendientes» que ordena el servidor (`FISCAL_DOCUMENT_SORT_KEYS`). */
const PENDING_SERVER_KEYS = {
  number: 'number',
  customer: 'customer',
  issue: 'issueDate',
  due: 'dueDate',
  total: 'total',
  paid: null,
  balance: null,
} as const;

type PendingSortKey = 'number' | 'customer' | 'issue' | 'due' | 'total' | 'paid' | 'balance';

/** D-289: lo que «Comprobantes con saldo» guarda en la URL. */
const PENDING_URL_DEFAULTS = {
  pPage: '1',
  pSize: String(DEFAULT_PAGE_SIZE),
  search: '',
  docType: '',
  origin: '',
};

/**
 * Los parámetros de «Comprobantes con saldo» para el API: la tabla los usa para su consulta y la
 * cabecera para su Excel (cc47b, D-623), así los dos ven el mismo buscar, filtros y orden.
 */
function pendingParamsOf(
  url: typeof PENDING_URL_DEFAULTS,
  sort: { key: PendingSortKey | null; dir: string },
): URLSearchParams {
  const params = new URLSearchParams({
    pendingOnly: 'true',
    page: String(Math.max(1, Number(url.pPage) || 1)),
    pageSize: String(Number(url.pSize) || DEFAULT_PAGE_SIZE),
  });
  if (url.docType) params.set('docType', url.docType);
  if (url.origin) params.set('origin', url.origin);
  if (url.search) params.set('search', url.search);
  const serverSort = sort.key === null ? null : PENDING_SERVER_KEYS[sort.key];
  if (serverSort) {
    params.set('sort', serverSort);
    params.set('dir', sort.dir);
  }
  return params;
}

/** D-289: lo que «Por cliente» guarda en la URL; cc48 (D-630) suma su buscar. */
const RECEIVABLES_URL_DEFAULTS = {
  rPage: '1',
  rSize: String(DEFAULT_PAGE_SIZE),
  rSearch: '',
};

/** cc48 (D-630): los parámetros de «Por cliente» para el API, de la tabla y de su Excel. */
function receivablesParamsOf(url: typeof RECEIVABLES_URL_DEFAULTS): URLSearchParams {
  const params = new URLSearchParams({
    page: String(Math.max(1, Number(url.rPage) || 1)),
    pageSize: String(Number(url.rSize) || DEFAULT_PAGE_SIZE),
  });
  // El API acepta hasta 80 caracteres (`receivablesQuerySchema`): una URL más larga no da 400.
  const search = url.rSearch.trim().slice(0, 80);
  if (search) params.set('search', search);
  return params;
}

/** Sin orden elegido: `sortRows` deja las filas como llegan. */
const NO_SORT = { key: null, dir: 'asc' } as const;

const TABS = ['cliente', 'pendientes'] as const;
type CobranzasTab = (typeof TABS)[number];

export function CobranzasView() {
  const { user } = useSession();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  // «Por cliente» es solo del administrador en el API (el vendedor recibe 403): el vendedor no
  // ve esa pestaña y queda en sus comprobantes con saldo, la tabla que sí puede ver.
  const tabs: readonly CobranzasTab[] = isAdmin ? TABS : ['pendientes'];
  const [tab, selectTab] = useUrlTab<CobranzasTab>(tabs, tabs[0] ?? 'pendientes');

  const totals = useQuery({
    queryKey: ['receivables-summary'],
    queryFn: () => api<ReceivableTotalsDto>('/invoicing/receivables/summary'),
  });
  /** Regla dura 1: el vencido se compara como `Decimal`, no como número ni como string. */
  const overdue = toDecimal(totals.data?.totalOverduePen ?? '0').gt(0);
  // cc47b (D-623): el Excel de la pestaña activa, con lo que esa tabla tiene puesto.
  const [pendingUrl] = useUrlState(PENDING_URL_DEFAULTS);
  const [pendingSort] = useSort<PendingSortKey>('p');
  const [receivablesUrl] = useUrlState(RECEIVABLES_URL_DEFAULTS);

  return (
    <RoleGate allow={SALES_ROLES}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Cobranzas</h1>
          <p className="text-xs text-muted-foreground">
            Saldo por comprobante. El cobro se registra desde el comprobante, y revertirlo devuelve
            el monto al saldo.
          </p>
        </div>
        {/* cc47b (D-623): las descargas, en «Más opciones»; la de la pestaña que se ve. cc26 M2:
            «Por cliente» trae todas las filas con su buscar (cc48, D-630; solo ADMINISTRADOR, como
            la pestaña); la de comprobantes, el buscar, los filtros y el orden de la tabla, y el
            vendedor recibe solo los suyos. */}
        <HeaderActions
          primary={[]}
          actions={[
            {
              key: 'xlsx-cliente',
              label: 'Descargar Excel · Por cliente',
              show: tab === 'cliente',
              download: listXlsxHref('/invoicing/receivables', receivablesParamsOf(receivablesUrl)),
            },
            {
              key: 'xlsx-pendientes',
              label: 'Descargar Excel · Comprobantes con saldo',
              show: tab === 'pendientes',
              download: listXlsxHref(
                '/invoicing/documents',
                pendingParamsOf(pendingUrl, pendingSort),
              ),
            },
          ]}
        />
      </div>

      {/* cc31: si las cifras no cargan se dice, en vez de dejar el esqueleto o un cero. */}
      {totals.isError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>No se pudieron cargar los totales por cobrar: el servidor no respondió.</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void totals.refetch();
              }}
            >
              Reintentar
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <StatStrip className="lg:grid-cols-3">
        <Stat label="Por cobrar">
          {totals.isError ? (
            <span className="text-muted-foreground">Sin datos</span>
          ) : totals.isPending ? (
            <Skeleton className="h-5 w-24" />
          ) : (
            formatMoney(totals.data?.totalBalancePen ?? '0')
          )}
        </Stat>
        {/*
          D-180: el rojo solo cuando hay algo vencido. Estaba fijo, así que «Vencido
          S/ 0.00» —que es la buena noticia— se pintaba igual que una deuda de miles. Rojo y
          ámbar están reservados para error y aviso, y un cero no es ninguno de los dos.
        */}
        {/* cc57 (E-08 de audit-01): dos «vencidos» distintos, y se dice: el del Panel cuenta el
            contado desde su emisión (D-428); este, solo lo que tiene fecha de vencimiento. */}
        <Stat
          label="Vencido"
          className={overdue ? 'text-destructive' : undefined}
          hint="Con fecha de vencimiento pasada; el Panel cuenta además el contado desde que se emite"
        >
          {totals.isError ? (
            <span className="text-muted-foreground">Sin datos</span>
          ) : totals.isPending ? (
            <Skeleton className="h-5 w-24" />
          ) : (
            formatMoney(totals.data?.totalOverduePen ?? '0')
          )}
        </Stat>
        <Stat label="Clientes">
          {totals.isError ? (
            <span className="text-muted-foreground">Sin datos</span>
          ) : totals.isPending ? (
            <Skeleton className="h-5 w-12" />
          ) : (
            (totals.data?.customerCount ?? 0)
          )}
        </Stat>
      </StatStrip>

      <Tabs
        activationMode="manual"
        value={tab}
        onValueChange={(next) => {
          selectTab(next as CobranzasTab);
        }}
      >
        <TabsList aria-label="Vista de cobranzas" data-testid="pestanas-cobranzas">
          {isAdmin && <TabsTrigger value="cliente">Por cliente</TabsTrigger>}
          <TabsTrigger value="pendientes">Comprobantes con saldo</TabsTrigger>
        </TabsList>
        {isAdmin && (
          <TabsContent value="cliente" className="mt-3 grid grid-cols-1 gap-2">
            <ReceivablesTab />
          </TabsContent>
        )}
        <TabsContent value="pendientes" className="mt-3 grid grid-cols-1 gap-2">
          <PendingTab />
        </TabsContent>
      </Tabs>
    </RoleGate>
  );
}

/**
 * «Por cliente»: el resumen armado en memoria por el API, paginado por el servidor. cc48 (D-630):
 * lleva buscar (cliente por nombre o documento), hecho en el API antes de paginar; no tiene nada más
 * que filtrar, así que no lleva «Filtros».
 */
function ReceivablesTab() {
  // D-289: la página, el tamaño y el buscar viven en la URL (`rPage`/`rSize`/`rSearch`).
  const [url, setUrl] = useUrlState(RECEIVABLES_URL_DEFAULTS);
  const receivablesPage = {
    page: Math.max(1, Number(url.rPage) || 1),
    pageSize: Number(url.rSize) || DEFAULT_PAGE_SIZE,
    setPage: (p: number) => {
      setUrl({ rPage: String(p) });
    },
    setPageSize: (size: number) => {
      setUrl({ rSize: String(size), rPage: '1' });
    },
  };
  // Buscar vuelve a la página 1 de esta tabla.
  const [searchText, setSearchText, search] = useUrlSearchInput(url.rSearch, (v) => {
    setUrl({ rSearch: v, rPage: '1' });
  });
  const receivablesParams = receivablesParamsOf(url);
  const receivables = useQuery({
    queryKey: ['receivables', receivablesPage.page, receivablesPage.pageSize, search],
    queryFn: () =>
      api<PaginatedResult<ReceivableSummaryDto>>(
        `/invoicing/receivables?${receivablesParams.toString()}`,
      ),
  });
  // D-323: «Por cliente» ordena solo las filas de la página y sus encabezados lo dicen.
  const [rSort, toggleRSort] = useSort<'customer' | 'count' | 'next' | 'overdue' | 'balance'>('r');
  const receivableRows = sortRows(receivables.data?.items ?? [], rSort, {
    customer: { text: (r) => r.customerName },
    count: { decimal: (r) => String(r.documentCount) },
    next: { text: (r) => r.nextDueDate ?? '' },
    overdue: { decimal: (r) => r.overduePen },
    balance: { decimal: (r) => r.balancePen },
  });

  return (
    <>
      <TableToolbar
        search={
          <ToolbarSearch
            label="Buscar clientes con saldo"
            placeholder="Buscar por cliente o documento…"
            value={searchText}
            onChange={setSearchText}
          />
        }
      />
      {receivables.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="rounded-lg border">
          {/* cc47b (D-624): una tabla por pestaña (D-617): lista con el scroll único (D-547). */}
          <Table list>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <SortHead
                  sort={rSort}
                  onSort={toggleRSort}
                  k="customer"
                  title="Ordena las filas de esta página"
                >
                  Cliente
                </SortHead>
                <SortHead
                  sort={rSort}
                  onSort={toggleRSort}
                  k="count"
                  className="hidden text-right sm:table-cell"
                  align="right"
                >
                  Comprobantes
                </SortHead>
                <SortHead
                  sort={rSort}
                  onSort={toggleRSort}
                  k="next"
                  className="hidden md:table-cell"
                >
                  Vencimiento más próximo
                </SortHead>
                <SortHead
                  sort={rSort}
                  onSort={toggleRSort}
                  k="overdue"
                  className="text-right"
                  align="right"
                >
                  Vencido
                </SortHead>
                <SortHead
                  sort={rSort}
                  onSort={toggleRSort}
                  k="balance"
                  className="text-right"
                  align="right"
                >
                  Saldo
                </SortHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receivableRows.map((r) => (
                <TableRow key={r.customerId}>
                  <TableCell className={CUSTOMER_CELL_CLASSNAME}>
                    <Link
                      href={customerSearchHref(r.customerDocNumber)}
                      className={cn('font-medium', LINK_CLASSNAME, CUSTOMER_NAME_CLASSNAME)}
                      title={r.customerName}
                    >
                      {r.customerName}
                    </Link>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.customerDocNumber}
                    </span>
                  </TableCell>
                  <TableCell className="hidden text-right sm:table-cell">
                    {r.documentCount}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {r.nextDueDate ? (
                      formatDate(r.nextDueDate)
                    ) : (
                      <span className="text-muted-foreground">
                        {r.creditWithoutDueCount > 0 ? CREDIT_WITHOUT_DUE_LABEL : 'Contado'}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {toDecimal(r.overduePen).gt(0) ? (
                      <span className="font-medium text-destructive">
                        {formatMoney(r.overduePen)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatMoney(r.balancePen)}
                  </TableCell>
                </TableRow>
              ))}
              <ListStateRows
                query={receivables}
                colSpan={5}
                isEmpty={receivableRows.length === 0}
                filtered={Boolean(search)}
                emptyTitle="No hay nada por cobrar"
                emptyHint="Aquí aparece cada cliente con comprobantes que tienen saldo."
                noResultsTitle="Ningún cliente con saldo coincide con la búsqueda"
                onClearFilters={() => {
                  setSearchText('');
                  setUrl({ rSearch: '', rPage: '1' });
                }}
                errorTitle="No se pudo cargar el saldo por cliente"
              />
            </TableBody>
          </Table>
        </div>
      )}
      {!receivables.isPending && (
        <PaginationBar
          page={receivablesPage.page}
          pageSize={receivablesPage.pageSize}
          total={receivables.data?.total ?? 0}
          onPageChange={receivablesPage.setPage}
          onPageSizeChange={receivablesPage.setPageSize}
          disabled={receivables.isFetching}
        />
      )}
    </>
  );
}

interface PendingFilters {
  docType: string;
  origin: string;
}

const NO_PENDING_FILTERS: PendingFilters = { docType: '', origin: '' };

/**
 * «Comprobantes con saldo»: la lista de comprobantes del API con `pendingOnly`, paginada y ordenada
 * por el servidor. El buscar y los filtros (tipo y origen) van también al API, los mismos de
 * `/comprobantes`, y viajan al Excel.
 */
function PendingTab() {
  // D-289: la página, el tamaño, el buscar y los filtros viven en la URL.
  const [url, setUrl] = useUrlState(PENDING_URL_DEFAULTS);
  const pendingPage = {
    page: Math.max(1, Number(url.pPage) || 1),
    pageSize: Number(url.pSize) || DEFAULT_PAGE_SIZE,
    setPage: (p: number) => {
      setUrl({ pPage: String(p) });
    },
    setPageSize: (size: number) => {
      setUrl({ pSize: String(size), pPage: '1' });
    },
  };
  // Buscar o filtrar vuelve a la página 1 de esta tabla.
  const [searchText, setSearchText, search] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v, pPage: '1' });
  });
  const { docType, origin } = url;

  const [pSort, togglePSort] = useSort<PendingSortKey>('p');
  const serverSort = pSort.key === null ? null : PENDING_SERVER_KEYS[pSort.key];
  // cc26 M2: los parámetros de la tabla, de los que salen la consulta y su Excel (sin página).
  const pendingParams = pendingParamsOf(url, pSort);
  const pending = useQuery({
    queryKey: [
      'fiscal-documents',
      'pending',
      pendingPage.page,
      pendingPage.pageSize,
      docType,
      origin,
      search,
      serverSort,
      pSort.dir,
    ],
    queryFn: () =>
      api<PaginatedResult<FiscalDocumentListItemDto>>(
        `/invoicing/documents?${pendingParams.toString()}`,
      ),
  });
  // El servidor ya entregó ordenadas las columnas propias; aquí solo lo derivado.
  const pendingRows = sortRows(pending.data?.items ?? [], serverSort ? NO_SORT : pSort, {
    paid: { decimal: (d) => d.paidPen },
    balance: { decimal: (d) => d.balancePen },
  });
  const filtered = Boolean(search || docType || origin);
  const activeCount = (docType ? 1 : 0) + (origin ? 1 : 0);

  return (
    <>
      <TableToolbar
        search={
          <ToolbarSearch
            label="Buscar comprobantes con saldo"
            placeholder="Buscar por número, cliente o documento…"
            value={searchText}
            onChange={setSearchText}
          />
        }
        filters={
          <FiltersDialog<PendingFilters>
            value={{ docType, origin }}
            empty={NO_PENDING_FILTERS}
            activeCount={activeCount}
            onApply={(next) => {
              setUrl({ ...next, pPage: '1' });
            }}
          >
            {(draft, update) => (
              <>
                <DocumentFilterFields
                  docType={draft.docType}
                  origin={draft.origin}
                  onChange={update}
                />
              </>
            )}
          </FiltersDialog>
        }
      />
      {pending.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="rounded-lg border">
          {/* cc47b (D-624): una tabla por pestaña (D-617): lista con el scroll único (D-547). */}
          <Table list>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <SortHead sort={pSort} onSort={togglePSort} k="number">
                  Número
                </SortHead>
                <SortHead sort={pSort} onSort={togglePSort} k="customer">
                  Cliente
                </SortHead>
                <SortHead
                  sort={pSort}
                  onSort={togglePSort}
                  k="issue"
                  className="hidden sm:table-cell"
                >
                  Emisión
                </SortHead>
                <SortHead sort={pSort} onSort={togglePSort} k="due">
                  Vencimiento
                </SortHead>
                <SortHead
                  sort={pSort}
                  onSort={togglePSort}
                  k="total"
                  className="hidden text-right md:table-cell"
                  align="right"
                >
                  Total
                </SortHead>
                <SortHead
                  sort={pSort}
                  onSort={togglePSort}
                  k="paid"
                  className="hidden text-right lg:table-cell"
                  align="right"
                >
                  Cobrado
                </SortHead>
                <SortHead
                  sort={pSort}
                  onSort={togglePSort}
                  k="balance"
                  className="text-right"
                  align="right"
                >
                  Saldo
                </SortHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pendingRows.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <Link
                      href={`/comprobantes/${d.id}`}
                      className={cn('font-medium', LINK_CLASSNAME)}
                    >
                      {d.number ?? 'Borrador'}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {FISCAL_DOC_TYPE_LABELS[d.docType]}
                    </div>
                  </TableCell>
                  <TableCell className={CUSTOMER_CELL_CLASSNAME}>
                    <Link
                      href={customerSearchHref(d.customerDocNumber)}
                      className={cn(LINK_CLASSNAME, CUSTOMER_NAME_CLASSNAME)}
                      title={d.customerName}
                    >
                      {d.customerName}
                    </Link>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{formatDate(d.issueDate)}</TableCell>
                  <TableCell>
                    {d.dueDate ? (
                      <span className={d.isOverdue ? 'font-medium text-destructive' : undefined}>
                        {formatDate(d.dueDate)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {noDueDateLabel(d.paymentTerms)}
                      </span>
                    )}
                    {d.isOverdue && (
                      <Badge variant="outline" className="ml-2">
                        Vencido
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-right md:table-cell">
                    {formatMoney(d.totalPen)}
                  </TableCell>
                  <TableCell className="hidden text-right lg:table-cell">
                    {formatMoney(d.paidPen)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatMoney(d.balancePen)}
                  </TableCell>
                </TableRow>
              ))}
              <ListStateRows
                query={pending}
                colSpan={7}
                isEmpty={pendingRows.length === 0}
                filtered={filtered}
                emptyTitle="Ningún comprobante tiene saldo pendiente"
                noResultsTitle="Ningún comprobante con saldo coincide con la búsqueda o los filtros"
                onClearFilters={() => {
                  setSearchText('');
                  setUrl({ search: '', ...NO_PENDING_FILTERS, pPage: '1' });
                }}
                errorTitle="No se pudieron cargar los comprobantes con saldo"
              />
            </TableBody>
          </Table>
        </div>
      )}
      {!pending.isPending && (
        <PaginationBar
          page={pendingPage.page}
          pageSize={pendingPage.pageSize}
          total={pending.data?.total ?? 0}
          onPageChange={pendingPage.setPage}
          onPageSizeChange={pendingPage.setPageSize}
          disabled={pending.isFetching}
        />
      )}
    </>
  );
}
