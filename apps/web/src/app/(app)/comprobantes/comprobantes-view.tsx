'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
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
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
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
import { FiscalDocumentStatusBadge } from '@/components/invoicing/status-badges';
import { Alert, AlertDescription } from '@/components/ui/alert';
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

const ALL = 'ALL';
/** §3.4: el módulo comercial es de ADMINISTRADOR y VENDEDOR. */
const SALES_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

/** RF-70: listado de comprobantes electrónicos, con el aviso de contingencia (D-073). */
export function ComprobantesView() {
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

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (status) params.set('status', status);
  if (docType) params.set('docType', docType);
  if (origin) params.set('origin', origin);
  if (pendingOnly) params.set('pendingOnly', 'true');
  if (search) params.set('search', search);

  const documents = useQuery({
    queryKey: ['fiscal-documents', page, pageSize, status, docType, origin, pendingOnly, search],
    queryFn: () =>
      api<PaginatedResult<FiscalDocumentListItemDto>>(`/invoicing/documents?${params.toString()}`),
  });

  const alerts = useQuery({
    queryKey: ['invoicing-alerts'],
    queryFn: () => api<{ pending: number; stalled: number }>('/invoicing/alerts'),
  });

  const rows = documents.data?.items ?? [];

  return (
    <RoleGate allow={SALES_ROLES}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Comprobantes</h1>
          <p className="text-xs text-muted-foreground">
            Facturas, boletas y notas de crédito. Un comprobante emitido ya permite despachar aunque
            el PSE todavía no lo haya aceptado.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* D-292: el estado del PSE, en un modal (ⓘ) con su badge en la cabecera. */}
          <ContingencyCard />
          <Button asChild>
            <Link href="/comprobantes/nuevo">Nuevo comprobante</Link>
          </Button>
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
        <Button
          variant={pendingOnly ? 'default' : 'outline'}
          aria-pressed={pendingOnly}
          onClick={() => {
            setUrl({ pendingOnly: pendingOnly ? '' : '1' });
          }}
        >
          Solo con saldo
        </Button>
      </div>

      {documents.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>Número</TableHead>
                <TableHead className="hidden md:table-cell">Tipo</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead className="hidden sm:table-cell">Emisión</TableHead>
                <TableHead className="hidden md:table-cell">Vencimiento</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
                <TableHead>Estado</TableHead>
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
                    {d.salesOrderCode && d.salesOrderId && (
                      <div className="text-xs">
                        <Link href={`/pedidos/${d.salesOrderId}`} className={LINK_CLASSNAME}>
                          {d.salesOrderCode}
                        </Link>
                      </div>
                    )}
                  </TableCell>
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
                    <span className="ml-2 text-xs text-muted-foreground">
                      {d.customerDocNumber}
                    </span>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{formatDate(d.issueDate)}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    {d.dueDate ? (
                      <span className={d.isOverdue ? 'font-medium text-destructive' : undefined}>
                        {formatDate(d.dueDate)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Contado</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{formatMoney(d.totalPen)}</TableCell>
                  <TableCell className="text-right">{formatMoney(d.balancePen)}</TableCell>
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
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No hay comprobantes que coincidan.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
      {!documents.isPending && (
        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={documents.data?.total ?? 0}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          disabled={documents.isFetching}
        />
      )}
    </RoleGate>
  );
}
