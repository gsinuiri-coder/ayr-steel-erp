'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { InvoiceDispatchPlanDto, InvoiceDispatchResultDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { invalidateInvoicing } from '@/lib/invoicing-queries';
import { formatDate } from '@/lib/format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const ACTION_LABELS: Record<InvoiceDispatchPlanDto['lines'][number]['action'], string> = {
  DISPATCH: 'Sale del almacén',
  BEFORE_OPENING: 'Entregada antes del inventario inicial (sin salida)',
  REVIEW: 'No se despacha',
};

/**
 * D-364: el comprobante tiene líneas facturadas sin despacho registrado. Ofrece —no hace—
 * despacharlas con la fecha calculada por D-285 o con una elegida. Lo decide el API línea por
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
  const [dispatchDate, setDispatchDate] = useState<string | undefined>(undefined);
  const [defaultDates, setDefaultDates] = useState<Record<number, string>>({});
  const plan = useQuery({
    queryKey: ['fiscal-document', documentId, 'dispatch-at-issue-date', dispatchDate],
    queryFn: () =>
      api<InvoiceDispatchPlanDto>(
        `/dispatches/at-issue-date/${documentId}${dispatchDate ? `?dispatchDate=${encodeURIComponent(dispatchDate)}` : ''}`,
      ),
  });
  const execute = useMutation({
    mutationFn: () =>
      api<InvoiceDispatchResultDto>(`/dispatches/at-issue-date/${documentId}`, {
        method: 'POST',
        body: dispatchDate ? { dispatchDate } : {},
      }),
    onSuccess: (result) => {
      const moved = result.lines.filter((l) => l.action !== 'REVIEW').length;
      toast.success(
        `${String(moved)} línea(s) despachada(s) en la fecha seleccionada` +
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
  useEffect(() => {
    if (dispatchDate !== undefined || plan.data === undefined) return;
    setDefaultDates(
      Object.fromEntries(plan.data.lines.map((line) => [line.lineNumber, line.operationDate])),
    );
  }, [dispatchDate, plan.data]);
  if (lines.length === 0) return null;
  const actionable = lines.some((l) => l.action !== 'REVIEW');
  const defaultFirstDate = defaultDates[lines[0]?.lineNumber ?? 0] ?? lines[0]?.operationDate ?? '';

  return (
    <Alert data-testid="dispatch-at-issue-date">
      <AlertDescription className="space-y-2">
        <p>
          Este comprobante tiene líneas facturadas <strong>sin despacho registrado</strong>. Se
          pueden despachar con la fecha de operación calculada, o elegir una posterior donde el
          stock exista.
        </p>
        <label className="grid max-w-xs gap-1 text-sm font-medium">
          Fecha de despacho
          <Input
            type="date"
            value={dispatchDate ?? defaultFirstDate}
            onChange={(event) => setDispatchDate(event.target.value || undefined)}
            aria-label="Fecha de despacho"
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Default D-285:{' '}
          {Object.entries(defaultDates).length > 0
            ? lines
                .map(
                  (line) =>
                    `Línea ${String(line.lineNumber)}: ${formatDate(defaultDates[line.lineNumber] ?? '')}`,
                )
                .join(' · ')
            : formatDate(defaultFirstDate)}
          . El kardex debe quedar sin saldo negativo.
        </p>
        <ul className="list-disc pl-5 text-sm">
          {lines.map((l) => (
            <li key={l.lineNumber}>
              Línea {l.lineNumber} · {l.sku} · {l.qty}: {ACTION_LABELS[l.action]}
              {l.action === 'REVIEW' && l.reason ? ` — ${l.reason}` : ''}
              {l.firstValidDate ? ` · Primera fecha válida: ${formatDate(l.firstValidDate)}` : ''}
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
            Despachar en la fecha seleccionada
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
