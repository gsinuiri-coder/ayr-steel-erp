'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { InvoiceDispatchPlanDto, InvoiceDispatchResultDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { invalidateInvoicing } from '@/lib/invoicing-queries';
import { formatDate } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

const ACTION_LABELS: Record<InvoiceDispatchPlanDto['lines'][number]['action'], string> = {
  DISPATCH: 'Sale del almacén',
  BEFORE_OPENING: 'Entregada antes del inventario inicial (sin salida)',
  REVIEW: 'No se despacha',
};

/**
 * D-278: el comprobante tiene líneas facturadas sin despacho registrado. Ofrece —no hace—
 * despacharlas con la fecha de emisión como fecha de operación. Lo decide el API línea por
 * línea: sale del almacén, se entrega sin salida (anterior al inventario inicial) o no se toca.
 *
 * La clave de la consulta cuelga de `['fiscal-document', id]`, así la invalida todo lo que ya
 * invalida el comprobante (emitir, registrar un manual, anular).
 */
export function DispatchAtIssueDate({
  documentId,
  salesOrderId,
}: {
  documentId: string;
  salesOrderId: string;
}) {
  const queryClient = useQueryClient();
  const plan = useQuery({
    queryKey: ['fiscal-document', documentId, 'dispatch-at-issue-date'],
    queryFn: () => api<InvoiceDispatchPlanDto>(`/dispatches/at-issue-date/${documentId}`),
  });
  const execute = useMutation({
    mutationFn: () =>
      api<InvoiceDispatchResultDto>(`/dispatches/at-issue-date/${documentId}`, {
        method: 'POST',
      }),
    onSuccess: (result) => {
      const moved = result.lines.filter((l) => l.action !== 'REVIEW').length;
      toast.success(
        `${String(moved)} línea(s) despachada(s) a la fecha del comprobante` +
          (result.lines.length > moved
            ? `; ${String(result.lines.length - moved)} quedaron sin despachar`
            : ''),
      );
      invalidateInvoicing(queryClient, { documentId, orderId: salesOrderId });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo despachar');
    },
  });

  const lines = plan.data?.lines ?? [];
  if (lines.length === 0) return null;
  const actionable = lines.some((l) => l.action !== 'REVIEW');

  return (
    <Alert data-testid="dispatch-at-issue-date">
      <AlertDescription className="space-y-2">
        <p>
          Este comprobante tiene líneas facturadas <strong>sin despacho registrado</strong>. Se
          pueden despachar con la fecha de emisión ({formatDate(lines[0]?.operationDate ?? '')})
          como fecha de salida del almacén.
        </p>
        <ul className="list-disc pl-5 text-sm">
          {lines.map((l) => (
            <li key={l.lineNumber}>
              Línea {l.lineNumber} · {l.sku} · {l.qty}: {ACTION_LABELS[l.action]}
              {l.action === 'REVIEW' && l.reason ? ` — ${l.reason}` : ''}
            </li>
          ))}
        </ul>
        {actionable && (
          <Button
            size="sm"
            pending={execute.isPending}
            pendingText="Despachando…"
            onClick={() => {
              execute.mutate();
            }}
          >
            Despachar a la fecha del comprobante
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
