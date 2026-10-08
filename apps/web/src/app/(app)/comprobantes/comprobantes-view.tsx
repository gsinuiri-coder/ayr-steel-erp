'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Decimal,
  FISCAL_DOC_TYPE_LABELS,
  FISCAL_DOCUMENT_ORIGIN_LABELS,
  FISCAL_DOCUMENT_ORIGINS,
  FISCAL_DOCUMENT_STATUS_LABELS,
  FISCAL_DOCUMENT_STATUSES,
  FiscalDocumentOrigin,
  INVOICE_DOC_TYPES,
  Role,
  type FiscalDocumentListItemDto,
  type PaginatedResult,
  type FiscalDocumentQuery,
  noDueDateLabel,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { listXlsxHref } from '@/lib/list-export';
import { HeaderActions } from '@/components/header-actions';
import { useSession } from '@/lib/session';
import { RowActions } from '@/components/row-actions';
import {
  canReactivate,
  ReactivateDocumentDialog,
} from '@/components/invoicing/reactivate-document-dialog';
import {
  canReactivateWithOrderLines,
  ReactivateWithOrderLinesDialog,
} from '@/components/invoicing/reactivate-with-order-lines-dialog';
import { currencyHeader, formatAmount, formatDate } from '@/lib/format';
import { FilterChip } from '@/components/filter-chip';
import { ListFooterRow } from '@/components/list-footer';
import { ListStateRows } from '@/components/list-state';
import {
  URL_PAGINATION_DEFAULTS,
  useUrlPagination,
  useUrlSearchInput,
  useUrlState,
} from '@/lib/use-url-state';
import { StatusFilter } from '@/components/status-filter';
import { PaginationBar } from '@/components/pagination-bar';
import { RoleGate } from '@/components/role-gate';
import { ContingencyCard } from '@/components/invoicing/contingency-card';
import { DocumentDispatchLinks } from '@/components/invoicing/document-dispatches';
import { FiscalDocumentStatusBadge } from '@/components/invoicing/status-badges';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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

const ALL = 'ALL';
/** §3.4: el módulo comercial es de ADMINISTRADOR y VENDEDOR. */
const SALES_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

/** RF-70: listado de comprobantes electrónicos, con el aviso de contingencia (D-073). */
export function ComprobantesView() {
  const { user } = useSession();
  // D-289: filtros, búsqueda y página viven en la URL. `origin` (D-153) separa lo que el ERP
  // emitió de lo que solo registró.
  const [url, setUrl] = useUrlState({
    ...URL_PAGINATION_DEFAULTS,
    search: '',
    status: '',
    docType: '',
    origin: '',
    pendingOnly: '',
  });
  const { page, pageSize, setPage, setPageSize } = useUrlPagination(url, setUrl);
  const [searchText, setSearchText, search] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });
  const { status, docType, origin } = url;
  const pendingOnly = url.pendingOnly === '1';

  // D-323: el orden por columna es del servidor (todas estas columnas son de la propia fila).
  const [sort, toggleSort] = useSort<NonNullable<FiscalDocumentQuery['sort']>>();

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (status) params.set('status', status);
  if (docType) params.set('docType', docType);
  if (origin) params.set('origin', origin);
  if (pendingOnly) params.set('pendingOnly', 'true');
  if (search) params.set('search', search);
  if (sort.key) {
    params.set('sort', sort.key);
    params.set('dir', sort.dir);
  }

  const documents = useQuery({
    queryKey: [
      'fiscal-documents',
      page,
      pageSize,
      status,
      docType,
      origin,
      pendingOnly,
      search,
      sort.key,
      sort.dir,
    ],
    queryFn: () =>
      api<PaginatedResult<FiscalDocumentListItemDto>>(`/invoicing/documents?${params.toString()}`),
  });

  const alerts = useQuery({
    queryKey: ['invoicing-alerts'],
    queryFn: () => api<{ pending: number; stalled: number }>('/invoicing/alerts'),
  });

  const rows = documents.data?.items ?? [];
  const isAdmin = user.role === Role.ADMINISTRADOR;
  // UAT de cc13: entre varios anulados hay que saber de qué pedido es cada uno, así que con el
  // chip de anulados el pedido va en su propia columna (y no debajo del número).
  const showOrderColumn = status.split(',').includes('ANNULLED');
  const columnCount = (isAdmin ? 10 : 9) + (showOrderColumn ? 1 : 0);
  const [reactivating, setReactivating] = useState<FiscalDocumentListItemDto | null>(null);
  const [reactivatingWithLines, setReactivatingWithLines] =
    useState<FiscalDocumentListItemDto | null>(null);

  // cc31: el filtro activo acompaña al título y al pie («4 de 38 comprobantes con saldo»).
  const filterParts: string[] = [];
  if (status === 'VOIDED,ANNULLED') {
    filterParts.push('anulados');
  } else if (status) {
    const label =
      FISCAL_DOCUMENT_STATUS_LABELS[status as keyof typeof FISCAL_DOCUMENT_STATUS_LABELS];
    filterParts.push(`en «${label}»`);
  }
  if (docType) {
    filterParts.push(
      `de tipo «${FISCAL_DOC_TYPE_LABELS[docType as keyof typeof FISCAL_DOC_TYPE_LABELS]}»`,
    );
  }
  if (origin) {
    filterParts.push(
      `«${FISCAL_DOCUMENT_ORIGIN_LABELS[origin as keyof typeof FISCAL_DOCUMENT_ORIGIN_LABELS]}»`,
    );
  }
  if (pendingOnly) filterParts.push('con saldo');
  if (filterParts.length === 0 && search) filterParts.push('que coinciden con la búsqueda');
  const filterLabel = filterParts.join(', ');
  const filtered = Boolean(search || status || docType || origin) || pendingOnly;
  // El pie suma el saldo, no el total: sumar totales mezclaría notas de crédito (positivas),
  // guías y anulados con lo facturado. El saldo ya es lo que se debe, documento por documento.
  const pageBalance = rows.reduce((acc, d) => acc.plus(d.balancePen), new Decimal(0));
  // Índice de la columna «Saldo» (la siguiente a «Total»): se corre uno con la columna de
  // pedido de los anulados.
  const balanceColumn = (showOrderColumn ? 7 : 6) + 1;

  return (
    <RoleGate allow={SALES_ROLES}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-semibold">Comprobantes</h1>
            {filterLabel && <span className="text-muted-foreground">{filterLabel}</span>}
          </div>
          <p className="text-xs text-muted-foreground">
            Facturas, boletas y notas de crédito. Un comprobante emitido ya permite despachar aunque
            el PSE todavía no lo haya aceptado.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* D-292: el estado del PSE, en un modal (ⓘ) con su badge en la cabecera. */}
          <ContingencyCard />
          {/* cc31: un solo botón principal y el Excel en «Más opciones». cc26: el Excel lleva
              los filtros y el orden de la lista (todas las páginas). */}
          <HeaderActions
            primary={['new']}
            actions={[
              { key: 'new', label: 'Nuevo comprobante', href: '/comprobantes/nuevo' },
              {
                key: 'xlsx',
                label: 'Descargar Excel',
                download: listXlsxHref('/invoicing/documents', params),
              },
            ]}
          />
        </div>
      </div>

      {/*
        El aviso de D-073. "Pendiente" no es un error —es el estado normal de un documento
        recién enviado—, así que solo se muestra cuando hay alguno que **pasó el umbral**:
        avisar de cada pendiente entrenaría a ignorar el aviso.
      */}
      {(alerts.data?.stalled ?? 0) > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            {alerts.data?.stalled === 1
              ? 'Un comprobante lleva'
              : `${alerts.data?.stalled} comprobantes llevan`}{' '}
            demasiado tiempo emitidos sin que el PSE los acepte. Ábrelos y reintenta el envío, o
            revisa si el proveedor está en contingencia.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Buscar por número, cliente o documento…"
          className="max-w-sm"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
          }}
        />
        <Select
          value={docType || ALL}
          onValueChange={(v) => {
            setUrl({ docType: v === ALL ? '' : v });
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Tipo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los tipos</SelectItem>
            {/* La guía de remisión se ve desde su despacho, no acá. */}
            {INVOICE_DOC_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {FISCAL_DOC_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={origin || ALL}
          onValueChange={(v) => {
            setUrl({ origin: v === ALL ? '' : v });
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Origen" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los orígenes</SelectItem>
            {FISCAL_DOCUMENT_ORIGINS.map((o) => (
              <SelectItem key={o} value={o}>
                {FISCAL_DOCUMENT_ORIGIN_LABELS[o]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <StatusFilter
          value={status}
          onChange={(v) => {
            setUrl({ status: v });
          }}
          options={FISCAL_DOCUMENT_STATUSES.filter((s) => s !== 'VOIDED' && s !== 'ANNULLED').map(
            (s) => ({ value: s, label: FISCAL_DOCUMENT_STATUS_LABELS[s] }),
          )}
          negativeValue="VOIDED,ANNULLED"
          allLabel="Todos, sin anulados"
        />
        <FilterChip
          active={pendingOnly}
          onToggle={() => {
            setUrl({ pendingOnly: pendingOnly ? '' : '1' });
          }}
        >
          Solo con saldo
        </FilterChip>
      </div>

      <div className="rounded-lg border">
        <Table list>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <SortableTableHead
                active={sort.key === 'number'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('number');
                }}
              >
                Número
              </SortableTableHead>
              {showOrderColumn && <TableHead>Pedido</TableHead>}
              <SortableTableHead
                className="hidden md:table-cell"
                active={sort.key === 'docType'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('docType');
                }}
              >
                Tipo
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
                active={sort.key === 'issueDate'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('issueDate');
                }}
              >
                Emisión
              </SortableTableHead>
              <SortableTableHead
                className="hidden md:table-cell"
                active={sort.key === 'dueDate'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('dueDate');
                }}
              >
                Vencimiento
              </SortableTableHead>
              {/* Correcciones 05 / M5: el despacho declarado, o los del pedido rotulados aparte. */}
              <TableHead className="hidden md:table-cell">Despacho</TableHead>
              <SortableTableHead
                className="text-right"
                align="right"
                active={sort.key === 'total'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('total');
                }}
              >
                {currencyHeader('Total')}
              </SortableTableHead>
              <TableHead className="text-right">{currencyHeader('Saldo')}</TableHead>
              <SortableTableHead
                active={sort.key === 'status'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('status');
                }}
              >
                Estado
              </SortableTableHead>
              {isAdmin && (
                <TableHead className="w-10">
                  <span className="sr-only">Acciones</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <Link
                    href={`/comprobantes/${d.id}`}
                    className={cn('font-medium', LINK_CLASSNAME)}
                  >
                    {/* Un borrador todavía no tiene número (D-072): se dice, no se finge. */}
                    {d.number ?? 'Borrador'}
                  </Link>
                  {!showOrderColumn && d.salesOrderCode && d.salesOrderId && (
                    <div className="text-xs">
                      <Link href={`/pedidos/${d.salesOrderId}`} className={LINK_CLASSNAME}>
                        {d.salesOrderCode}
                      </Link>
                    </div>
                  )}
                </TableCell>
                {showOrderColumn && (
                  <TableCell>
                    {d.salesOrderCode && d.salesOrderId ? (
                      <Link href={`/pedidos/${d.salesOrderId}`} className={LINK_CLASSNAME}>
                        {d.salesOrderCode}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                )}
                <TableCell className="hidden md:table-cell">
                  {FISCAL_DOC_TYPE_LABELS[d.docType]}
                </TableCell>
                <TableCell className={CUSTOMER_CELL_CLASSNAME}>
                  <Link
                    href={customerSearchHref(d.customerDocNumber)}
                    className={cn(LINK_CLASSNAME, CUSTOMER_NAME_CLASSNAME)}
                    title={d.customerName}
                  >
                    {d.customerName}
                  </Link>
                  <span className="ml-2 text-xs text-muted-foreground">{d.customerDocNumber}</span>
                </TableCell>
                <TableCell className="hidden sm:table-cell">{formatDate(d.issueDate)}</TableCell>
                <TableCell className="hidden md:table-cell">
                  {d.dueDate ? (
                    <span className={d.isOverdue ? 'font-medium text-destructive' : undefined}>
                      {formatDate(d.dueDate)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{noDueDateLabel(d.paymentTerms)}</span>
                  )}
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <DocumentDispatchLinks
                    invoicedDispatches={d.invoicedDispatches}
                    orderDispatches={d.orderDispatches}
                  />
                </TableCell>
                <TableCell className="text-right">{formatAmount(d.totalPen)}</TableCell>
                <TableCell className="text-right">{formatAmount(d.balancePen)}</TableCell>
                <TableCell>
                  <FiscalDocumentStatusBadge status={d.status} isStalled={d.isStalled} />
                  {d.isOverdue && (
                    <Badge variant="outline" className="ml-2">
                      Vencido
                    </Badge>
                  )}
                  {/*
                      D-105/D-153: "aceptado" quiere decir tres cosas distintas según de dónde
                      salió el documento. En uno importado o manual, el ERP no vio esa
                      aceptación: la afirma el papel. Por eso el origen se marca siempre que no
                      sea el normal, y no solo para lo importado.
                    */}
                  {d.origin !== FiscalDocumentOrigin.ISSUED_HERE && (
                    <Badge variant="secondary" className="ml-2">
                      {FISCAL_DOCUMENT_ORIGIN_LABELS[d.origin]}
                    </Badge>
                  )}
                </TableCell>
                {isAdmin && (
                  <TableCell className="w-10">
                    {/* D-373: «Reactivar» vive en el menú de la fila, solo en lo que la API acepta. */}
                    <RowActions
                      label={d.number ?? 'Borrador'}
                      primary={null}
                      actions={[
                        {
                          key: 'reactivate',
                          label: 'Reactivar',
                          show: canReactivate(d),
                          onSelect: () => {
                            setReactivating(d);
                          },
                        },
                        {
                          // D-378: el papel está bien y al pedido le faltaron ítems.
                          key: 'reactivate-with-order-lines',
                          label: 'Reactivar con las líneas del pedido',
                          show: canReactivateWithOrderLines(d),
                          onSelect: () => {
                            setReactivatingWithLines(d);
                          },
                        },
                      ]}
                    />
                  </TableCell>
                )}
              </TableRow>
            ))}
            <ListStateRows
              query={documents}
              colSpan={columnCount}
              isEmpty={rows.length === 0}
              filtered={filtered}
              emptyTitle="Todavía no hay comprobantes"
              emptyHint="Emite el primero con «Nuevo comprobante»."
              noResultsTitle={
                search
                  ? `Ningún comprobante coincide con «${search}»`
                  : 'Ningún comprobante con este filtro'
              }
              onClearFilters={() => {
                setSearchText('');
                setUrl({ search: '', status: '', docType: '', origin: '', pendingOnly: '' });
              }}
              errorTitle="No se pudieron cargar los comprobantes"
            />
          </TableBody>
          {rows.length > 0 && (
            <ListFooterRow
              shown={rows.length}
              total={documents.data?.total ?? rows.length}
              noun={filterLabel ? `comprobantes ${filterLabel}` : 'comprobantes'}
              colCount={columnCount}
              amountColumn={balanceColumn}
              amount={formatAmount(pageBalance)}
            />
          )}
        </Table>
      </div>
      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={documents.data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={documents.isFetching}
      />
      {reactivating && (
        <ReactivateDocumentDialog
          document={reactivating}
          open
          onOpenChange={(open) => {
            if (!open) setReactivating(null);
          }}
        />
      )}
      {reactivatingWithLines && (
        <ReactivateWithOrderLinesDialog
          document={reactivatingWithLines}
          open
          onOpenChange={(open) => {
            if (!open) setReactivatingWithLines(null);
          }}
        />
      )}
    </RoleGate>
  );
}
