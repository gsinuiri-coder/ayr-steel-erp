'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  FISCAL_DOC_TYPE_LABELS,
  type OrderAnnulledDocumentDto,
  type ReactivationAvailabilityDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatMoney, formatTimestampDate } from '@/lib/format';
import { LINK_CLASSNAME } from '@/lib/utils';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ReactivateDocumentDialog } from './reactivate-document-dialog';
import { ReactivateWithOrderLinesDialog } from './reactivate-with-order-lines-dialog';

function Why({ id, label, a }: { id: string; label: string; a: ReactivationAvailabilityDto }) {
  if (a.ok) return null;
  return (
    <p id={id} className="mt-1 text-xs text-muted-foreground">
      {label}: {a.reason ?? 'no aplica'}
    </p>
  );
}

function AnnulledRow({ d }: { d: OrderAnnulledDocumentDto }) {
  const [reactivateOpen, setReactivateOpen] = useState(false);
  const [withLinesOpen, setWithLinesOpen] = useState(false);
  const linesWhy = `${d.id}-lines-why`;
  const simpleWhy = `${d.id}-simple-why`;

  return (
    <TableRow data-testid={`annulled-${d.number ?? d.id}`}>
      <TableCell>
        <Link href={`/comprobantes/${d.id}`} className={LINK_CLASSNAME}>
          {d.number ?? 'Comprobante'}
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
            disabled={!d.withOrderLines.ok}
            aria-describedby={d.withOrderLines.ok ? undefined : linesWhy}
            onClick={() => {
              setWithLinesOpen(true);
            }}
          >
            Reactivar con las líneas del pedido
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!d.simple.ok}
            aria-describedby={d.simple.ok ? undefined : simpleWhy}
            onClick={() => {
              setReactivateOpen(true);
            }}
          >
            Reactivar
          </Button>
        </div>
        <Why id={linesWhy} label="Con las líneas del pedido" a={d.withOrderLines} />
        <Why id={simpleWhy} label="Reactivar" a={d.simple} />
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
 *
 * - **Una sola llamada** (`GET /invoicing/orders/:id/annulled-documents`), y solo si el pedido
 *   tiene anulados: `annulledCount` sale de la consulta de comprobantes que el detalle ya hacía,
 *   así que un pedido sin anulados no paga nada.
 * - Esa llamada comprueba **sin bloqueos**: solo pinta. Si una acción no aplica, queda
 *   deshabilitada con el motivo. El modal de D-378 y las dos ejecuciones vuelven a comprobar todo
 *   con sus locks.
 */
export function AnnulledDocumentsCard({
  salesOrderId,
  annulledCount,
}: {
  salesOrderId: string;
  annulledCount: number;
}) {
  const documents = useQuery({
    queryKey: ['fiscal-documents', 'annulled-of-order', salesOrderId],
    queryFn: () =>
      api<OrderAnnulledDocumentDto[]>(`/invoicing/orders/${salesOrderId}/annulled-documents`),
    enabled: annulledCount > 0,
    // Los bloqueos cambian con lo que se haga en el pedido: siempre fresca al volver.
    staleTime: 0,
  });
  // Un conteo viejo (el pedido en caché antes de reactivar) no pinta una tabla vacía.
  if (annulledCount === 0 || documents.data?.length === 0) return null;

  return (
    <Section title="Comprobantes anulados">
      {documents.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : documents.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {documents.error instanceof ApiError
            ? documents.error.message
            : 'No se pudieron cargar los comprobantes anulados'}
        </p>
      ) : (
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
            {documents.data.map((d) => (
              <AnnulledRow key={d.id} d={d} />
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}
