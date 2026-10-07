'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { errorMessage, toast } from '@/lib/notify';
import {
  FiscalDocType,
  FiscalDocumentOrigin,
  FiscalDocumentStatus,
  type FiscalDocumentDto,
  type FiscalDocumentListItemDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatTimestampDate } from '@/lib/format';
import { invalidateInvoicing } from '@/lib/invoicing-queries';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** El valor de `?despacho=` que pide sugerir la fecha del comprobante en el despacho D-364. */
export const DISPATCH_AT_DOCUMENT_DATE = 'fecha-comprobante';

/**
 * D-373: lo que la API acepta reactivar. La fila lo muestra solo si se cumple; la API lo vuelve
 * a comprobar con sus bloqueos (cobros, notas de crédito, líneas refacturadas, borradores).
 */
export function canReactivate(
  d: Pick<FiscalDocumentListItemDto, 'docType' | 'status' | 'origin' | 'archivedAt'>,
): boolean {
  return (
    (d.docType === FiscalDocType.FACTURA || d.docType === FiscalDocType.BOLETA) &&
    d.status === FiscalDocumentStatus.ANNULLED &&
    d.origin !== FiscalDocumentOrigin.ISSUED_HERE &&
    d.archivedAt === null
  );
}

/**
 * D-373: reactivar un comprobante manual o importado anulado por error. Motivo y casilla
 * obligatorios. No despacha: al terminar lleva al detalle, donde el despacho D-364 queda
 * sugerido a la fecha del comprobante (todo comprobante tiene su salida en el kardex con su
 * fecha).
 */
export function ReactivateDocumentDialog({
  document: d,
  open,
  onOpenChange,
}: {
  document: Pick<
    FiscalDocumentListItemDto,
    'id' | 'number' | 'issueDate' | 'salesOrderId' | 'annulledAt' | 'annulledByName' | 'annulReason'
  >;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setConfirmed(false);
    }
  }, [open]);

  const reactivate = useMutation({
    mutationFn: (body: { reason: string; confirmStillValid: boolean }) =>
      api<FiscalDocumentDto>(`/invoicing/documents/${d.id}/reactivate`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      toast.success(
        `${d.number ?? 'Comprobante'} reactivado. Queda pendiente de despacho: despáchalo con la fecha del comprobante (${formatDate(d.issueDate)}).`,
      );
      onOpenChange(false);
      invalidateInvoicing(queryClient, {
        documentId: d.id,
        orderId: d.salesOrderId ?? undefined,
      });
      router.push(`/comprobantes/${d.id}?despacho=${DISPATCH_AT_DOCUMENT_DATE}`);
    },
    onError: (err: unknown) => {
      toast.error(errorMessage(err, 'No se pudo reactivar'));
    },
  });

  const trimmed = reason.trim();
  const ready = trimmed.length >= 3 && confirmed;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reactivar {d.number ?? 'comprobante'}</DialogTitle>
          <DialogDescription>
            Deshace una anulación hecha por error: el comprobante vuelve a estar aceptado, con su
            deuda y sus líneas facturadas. No crea despacho.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Anulado</dt>
          <dd>
            {d.annulledAt ? formatTimestampDate(d.annulledAt) : '—'}
            {d.annulledByName ? ` · ${d.annulledByName}` : ''}
          </dd>
          <dt className="text-muted-foreground">Motivo</dt>
          <dd>{d.annulReason ?? '—'}</dd>
        </dl>
        <div className="grid gap-2">
          <Label htmlFor="reactivate-reason">Motivo de la reactivación</Label>
          <Input
            id="reactivate-reason"
            value={reason}
            maxLength={240}
            aria-describedby="reactivate-reason-hint"
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
          <p id="reactivate-reason-hint" className="text-xs text-muted-foreground">
            Di por qué se reactiva.
          </p>
          {trimmed.length > 0 && trimmed.length < 3 && (
            <p className="text-sm text-destructive">Explica el motivo en al menos 3 caracteres.</p>
          )}
          <span className="flex items-start gap-2">
            <Checkbox
              id="reactivate-confirm"
              checked={confirmed}
              onCheckedChange={(checked) => {
                setConfirmed(checked === true);
              }}
            />
            <Label htmlFor="reactivate-confirm" className="leading-snug">
              Confirmo que este comprobante sigue vigente en Nubefact/SUNAT (no se comunicó su baja)
            </Label>
          </span>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancelar
          </Button>
          <Button
            disabled={!ready || reactivate.isPending}
            pending={reactivate.isPending}
            pendingText="Reactivando…"
            onClick={() => {
              if (!ready || reactivate.isPending) return;
              reactivate.mutate({ reason: trimmed, confirmStillValid: confirmed });
            }}
          >
            Reactivar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
