'use client';

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
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useUrlState } from '@/lib/use-url-state';
import { PaginationBar } from '@/components/pagination-bar';
import { Stat, StatStrip } from '@/components/stat-strip';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
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

/** Sin orden elegido: `sortRows` deja las filas como llegan. */
const NO_SORT = { key: null, dir: 'asc' } as const;

export function CobranzasView() {
  // D-289: la página y el tamaño de cada tabla viven en la URL (`rPage`/`rSize`, `pPage`/`pSize`).
  const [url, setUrl] = useUrlState({
    rPage: '1',
    rSize: String(DEFAULT_PAGE_SIZE),
    pPage: '1',
    pSize: String(DEFAULT_PAGE_SIZE),
  });
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

  const totals = useQuery({
    queryKey: ['receivables-summary'],
    queryFn: () => api<ReceivableTotalsDto>('/invoicing/receivables/summary'),
  });
  /** Regla dura 1: el vencido se compara como `Decimal`, no como número ni como string. */
  const overdue = toDecimal(totals.data?.totalOverduePen ?? '0').gt(0);

  const receivables = useQuery({
    queryKey: ['receivables', receivablesPage.page, receivablesPage.pageSize],
    queryFn: () =>
      api<PaginatedResult<ReceivableSummaryDto>>(
        `/invoicing/receivables?page=${receivablesPage.page}&pageSize=${receivablesPage.pageSize}`,
      ),
  });
  // D-323: las dos tablas están paginadas por el servidor. «Por cliente» (resumen armado en
  // memoria) ordena solo las filas de la página y sus encabezados lo dicen; «Pendientes»
  // (comprobantes) manda al servidor las columnas propias del comprobante y ordena en la página
  // solo lo derivado (cobrado y saldo). Cada tabla lleva su propio par de parámetros en la URL.
  const [rSort, toggleRSort] = useSort<'customer' | 'count' | 'next' | 'overdue' | 'balance'>('r');
  const [pSort, togglePSort] = useSort<
    'number' | 'customer' | 'issue' | 'due' | 'total' | 'paid' | 'balance'
  >('p');
  const receivableRows = sortRows(receivables.data?.items ?? [], rSort, {
    customer: { text: (r) => r.customerName },
    count: { decimal: (r) => String(r.documentCount) },
    next: { text: (r) => r.nextDueDate ?? '' },
    overdue: { decimal: (r) => r.overduePen },
    balance: { decimal: (r) => r.balancePen },
  });

  const serverSort = pSort.key === null ? null : PENDING_SERVER_KEYS[pSort.key];
  const pending = useQuery({
    queryKey: [
      'fiscal-documents',
      'pending',
      pendingPage.page,
      pendingPage.pageSize,
      serverSort,
      pSort.dir,
    ],
    queryFn: () =>
      api<PaginatedResult<FiscalDocumentListItemDto>>(
        `/invoicing/documents?pendingOnly=true&page=${pendingPage.page}&pageSize=${pendingPage.pageSize}${
          serverSort ? `&sort=${serverSort}&dir=${pSort.dir}` : ''
        }`,
      ),
  });
  // El servidor ya entregó ordenadas las columnas propias; acá solo lo derivado.
  const pendingRows = sortRows(pending.data?.items ?? [], serverSort ? NO_SORT : pSort, {
    paid: { decimal: (d) => d.paidPen },
    balance: { decimal: (d) => d.balancePen },
  });

  return (
    <RoleGate allow={SALES_ROLES}>
      <div>
        <h1 className="text-lg font-semibold">Cobranzas</h1>
        <p className="text-xs text-muted-foreground">
          Saldo por comprobante. El cobro se registra desde el comprobante, y revertirlo devuelve el
          monto al saldo.
        </p>
      </div>

      <StatStrip className="lg:grid-cols-3">
        <Stat label="Por cobrar">
          {totals.isPending ? (
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
        <Stat label="Vencido" className={overdue ? 'text-destructive' : undefined}>
          {totals.isPending ? (
            <Skeleton className="h-5 w-24" />
          ) : (
            formatMoney(totals.data?.totalOverduePen ?? '0')
          )}
        </Stat>
        <Stat label="Clientes">
          {totals.isPending ? <Skeleton className="h-5 w-12" /> : (totals.data?.customerCount ?? 0)}
        </Stat>
      </StatStrip>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Por cliente</h2>
        {receivables.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="rounded-lg border">
            <Table>
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
                        <span className="text-muted-foreground">Contado</span>
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
                {receivables.isSuccess && receivableRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No hay nada por cobrar.
                    </TableCell>
                  </TableRow>
                )}
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
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Comprobantes con saldo</h2>
        {pending.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="rounded-lg border">
            <Table>
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
                    <TableCell className="hidden sm:table-cell">
                      {formatDate(d.issueDate)}
                    </TableCell>
                    <TableCell>
                      {d.dueDate ? (
                        <span className={d.isOverdue ? 'font-medium text-destructive' : undefined}>
                          {formatDate(d.dueDate)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Contado</span>
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
                {pending.isSuccess && pendingRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      Ningún comprobante tiene saldo pendiente.
                    </TableCell>
                  </TableRow>
                )}
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
      </section>
    </RoleGate>
  );
}
