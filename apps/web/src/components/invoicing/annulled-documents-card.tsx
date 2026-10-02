'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  FISCAL_DOC_TYPE_LABELS,
  type FiscalDocumentListItemDto,
  type PaginatedResult,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatMoney, formatTimestampDate } from '@/lib/format';
import { LINK_CLASSNAME } from '@/lib/utils';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { canReactivate, ReactivateDocumentDialog } from './reactivate-document-dialog';
import {
  canReactivateWithOrderLines,
  ReactivateWithOrderLinesDialog,
} from './reactivate-with-order-lines-dialog';

/**
 * Lo que dice una vista previa: si la acción aplica o, si no, el motivo (el mismo mensaje que
 * daría el API al intentarla). `null` mientras se consulta.
 */
type Availability = { ok: true } | { ok: false; reason: string } | null;

function useAvailability(path: string, applies: string | null): Availability {
  const query = useQuery({
    queryKey: ['fiscal-document', path],
    queryFn: () => api(path),
    enabled: applies === null,
    retry: false,
    // Los bloqueos cambian con lo que otros hagan en el pedido: siempre fresca.
    staleTime: 0,
  });
  if (applies !== null) return { ok: false, reason: applies };
  if (query.isSuccess) return { ok: true };
  if (query.isError) {
    return {
      ok: false,
      reason: query.error instanceof ApiError ? query.error.message : 'No se pudo comprobar',
    };
  }
  return null;
}

function AnnulledRow({ d }: { d: FiscalDocumentListItemDto }) {
  const [reactivateOpen, setReactivateOpen] = useState(false);
  const [withLinesOpen, setWithLinesOpen] = useState(false);
  // Lo que se sabe sin preguntar al API; el resto lo dice su vista previa.
  const withLines = useAvailability(
    `/invoicing/documents/${d.id}/reactivate-with-order-lines/preview`,
    canReactivateWithOrderLines(d)
      ? null
      : 'Solo se reactiva con las líneas del pedido una factura o boleta manual de un pedido, no archivada',
  );
  const simple = useAvailability(
    `/invoicing/documents/${d.id}/reactivate/preview`,
    canReactivate(d)
      ? null
      : 'Solo se reactiva una factura o boleta manual o importada, no archivada',
  );
  const label = d.number ?? 'Comprobante';

  return (
    <TableRow data-testid={`annulled-${d.number ?? d.id}`}>
      <TableCell>
        <Link href={`/comprobantes/${d.id}`} className={LINK_CLASSNAME}>
          {label}
        </Link>
        <div className="text-xs text-muted-foreground">{FISCAL_DOC_TYPE_LABELS[d.docType]}</div>
      </TableCell>
      <TableCell>{formatDate(d.issueDate)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatMoney(d.totalPen)}</TableCell>
      <TableCell>{d.annulReason ?? '—'}</TableCell>
      <TableCell>
        {d.annulledAt ? formatTimestampDate(d.annulledAt) : '—'}
        {d.annulledByName && (
          <div className="text-xs text-muted-foreground">{d.annulledByName}</div>
        )}
      </TableCell>
      <TableCell className="min-w-72">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={withLines?.ok !== true}
            aria-describedby={withLines?.ok === false ? `${d.id}-lines-why` : undefined}
            onClick={() => {
              setWithLinesOpen(true);
            }}
          >
            Reactivar con las líneas del pedido
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={simple?.ok !== true}
            aria-describedby={simple?.ok === false ? `${d.id}-simple-why` : undefined}
            onClick={() => {
              setReactivateOpen(true);
            }}
          >
            Reactivar
          </Button>
        </div>
        {(withLines === null || simple === null) && (
          <p className="mt-1 text-xs text-muted-foreground">Comprobando…</p>
        )}
        {withLines?.ok === false && (
          <p id={`${d.id}-lines-why`} className="mt-1 text-xs text-muted-foreground">
            Con las líneas del pedido: {withLines.reason}
          </p>
        )}
        {simple?.ok === false && (
          <p id={`${d.id}-simple-why`} className="mt-1 text-xs text-muted-foreground">
            Reactivar: {simple.reason}
          </p>
        )}
      </TableCell>
      {withLinesOpen && (
        <ReactivateWithOrderLinesDialog document={d} open onOpenChange={setWithLinesOpen} />
      )}
      {reactivateOpen && (
        <ReactivateDocumentDialog document={d} open onOpenChange={setReactivateOpen} />
      )}
    </TableRow>
  );
}

/**
 * Pedido del dueño en el UAT de cc13: la reactivación se decide desde el pedido. Entre varias
 * facturas anuladas no se sabía cuál era de qué pedido, así que el detalle del pedido lista las
 * suyas con las dos reactivaciones (D-373 y D-378), con las mismas reglas y los mismos modales.
 * Si una acción no aplica, queda deshabilitada con el motivo que da su vista previa. Solo
 * administrador; sin anulados, la sección no se muestra.
 */
export function AnnulledDocumentsCard({ salesOrderId }: { salesOrderId: string }) {
  const documents = useQuery({
    queryKey: ['fiscal-documents', 'annulled-of-order', salesOrderId],
    queryFn: () =>
      api<PaginatedResult<FiscalDocumentListItemDto>>(
        `/invoicing/documents?salesOrderId=${salesOrderId}&status=ANNULLED&pageSize=50`,
      ),
  });
  const rows = documents.data?.items ?? [];
  if (rows.length === 0) return null;

  return (
    <Section title="Comprobantes anulados">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Número</TableHead>
            <TableHead>Emisión</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead>Motivo</TableHead>
            <TableHead>Anulado</TableHead>
            <TableHead>Acciones</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((d) => (
            <AnnulledRow key={d.id} d={d} />
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}
