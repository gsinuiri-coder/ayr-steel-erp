'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  FISCAL_DOC_TYPE_LABELS,
  FISCAL_DOC_TYPES,
  FISCAL_DOCUMENT_STATUS_LABELS,
  FISCAL_DOCUMENT_STATUSES,
  Role,
  type FiscalDocumentListItemDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { RoleGate } from '@/components/role-gate';
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
  const [status, setStatus] = useState<string>(ALL);
  const [docType, setDocType] = useState<string>(ALL);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search.trim(), 300);

  const params = new URLSearchParams();
  if (status !== ALL) params.set('status', status);
  if (docType !== ALL) params.set('docType', docType);
  if (pendingOnly) params.set('pendingOnly', 'true');
  if (debouncedSearch) params.set('search', debouncedSearch);
  const query = params.toString();

  const documents = useQuery({
    queryKey: ['fiscal-documents', status, docType, pendingOnly, debouncedSearch],
    queryFn: () =>
      api<FiscalDocumentListItemDto[]>(`/invoicing/documents${query ? `?${query}` : ''}`),
  });

  const alerts = useQuery({
    queryKey: ['invoicing-alerts'],
    queryFn: () => api<{ pending: number; stalled: number }>('/invoicing/alerts'),
  });

  const rows = documents.data ?? [];

  return (
    <RoleGate allow={SALES_ROLES}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Comprobantes</h1>
          <p className="text-sm text-muted-foreground">
            Facturas, boletas y notas de crédito. Un comprobante emitido ya permite despachar aunque
            el PSE todavía no lo haya aceptado.
          </p>
        </div>
        <Button asChild>
          <Link href="/comprobantes/nuevo">Nuevo comprobante</Link>
        </Button>
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

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Buscar por número, cliente o documento…"
          className="max-w-sm"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
        <Select value={docType} onValueChange={setDocType}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Tipo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los tipos</SelectItem>
            {FISCAL_DOC_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {FISCAL_DOC_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los estados</SelectItem>
            {FISCAL_DOCUMENT_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {FISCAL_DOCUMENT_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={pendingOnly ? 'default' : 'outline'}
          onClick={() => {
            setPendingOnly((v) => !v);
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
            <TableHeader>
              <TableRow>
                <TableHead>Número</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Emisión</TableHead>
                <TableHead>Vencimiento</TableHead>
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
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {/* Un borrador todavía no tiene número (D-072): se dice, no se finge. */}
                      {d.number ?? 'Borrador'}
                    </Link>
                    {d.salesOrderCode && (
                      <div className="text-xs text-muted-foreground">{d.salesOrderCode}</div>
                    )}
                  </TableCell>
                  <TableCell>{FISCAL_DOC_TYPE_LABELS[d.docType]}</TableCell>
                  <TableCell>
                    <div>{d.customerName}</div>
                    <div className="text-xs text-muted-foreground">{d.customerDocNumber}</div>
                  </TableCell>
                  <TableCell>{formatDate(d.issueDate)}</TableCell>
                  <TableCell>
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
    </RoleGate>
  );
}
