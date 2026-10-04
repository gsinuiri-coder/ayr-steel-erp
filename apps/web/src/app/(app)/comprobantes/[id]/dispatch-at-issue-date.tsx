'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { InvoiceDispatchPlanDto, InvoiceDispatchResultDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { invalidateInvoicing } from '@/lib/invoicing-queries';
import { formatDate } from '@/lib/format';
import { cn, LINK_CLASSNAME } from '@/lib/utils';
import { restoreReservationHref } from '@/lib/restore-reservation';
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
  suggestedDate,
}: {
  documentId: string;
  salesOrderId: string;
  /**
   * D-373: fecha con la que arranca el campo en vez del default de D-285. La pasa el detalle
   * después de reactivar un comprobante: su salida va con la fecha del comprobante.
   */
  suggestedDate?: string;
}) {
  const queryClient = useQueryClient();
  const [dispatchDate, setDispatchDate] = useState<string | undefined>(suggestedDate);
  // D-387: el plan con el default de D-285 decide si la tarjeta existe y rotula el default.
  // Antes la tarjeta colgaba del plan de la fecha elegida: cada cambio de fecha abría una
  // consulta sin datos, la tarjeta devolvía `null` hasta la respuesta y el campo volvía como
  // otro nodo, sin foco (tipear el año se cortaba en cada dígito). Con una fecha que el API
  // rechaza no volvía nunca. Qué líneas hay no depende de la fecha; solo qué pasa con cada una.
  const defaultPlan = useQuery({
    queryKey: ['fiscal-document', documentId, 'dispatch-at-issue-date', undefined],
    queryFn: () => api<InvoiceDispatchPlanDto>(`/dispatches/at-issue-date/${documentId}`),
  });
  const datedPlan = useQuery({
    // Clave propia (`'on'`): sin fecha, compartir `[…, undefined]` con el default hacía que una
    // invalidación refrescara esa entrada con esta `queryFn` y un `?dispatchDate=` vacío (400).
    queryKey: ['fiscal-document', documentId, 'dispatch-at-issue-date', 'on', dispatchDate],
    queryFn: () =>
      api<InvoiceDispatchPlanDto>(
        `/dispatches/at-issue-date/${documentId}?dispatchDate=${encodeURIComponent(dispatchDate ?? '')}`,
      ),
    enabled: dispatchDate !== undefined,
    // Mientras llega el plan de la fecha nueva se sigue viendo el anterior, marcado como viejo.
    placeholderData: keepPreviousData,
    // Un 4xx (fecha futura, anterior a la carga histórica) no mejora reintentando.
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
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

  const defaultLines = defaultPlan.data?.lines ?? [];
  if (defaultLines.length === 0) return null;
  const selected = dispatchDate === undefined ? defaultPlan : datedPlan;
  // El plan a la vista es el de la fecha del campo: ni el anterior (placeholder) ni uno en error.
  const planReady = selected.isSuccess && !selected.isPlaceholderData;
  const planError =
    selected.isError && !selected.isFetching
      ? selected.error instanceof ApiError
        ? selected.error.message
        : 'No se pudo calcular el plan para esa fecha'
      : null;
  const lines = selected.data?.lines ?? defaultLines;
  const actionable = planReady && lines.some((l) => l.action !== 'REVIEW');
  const defaultDates = new Map(defaultLines.map((line) => [line.lineNumber, line.operationDate]));
  const defaultFirstDate = defaultLines[0]?.operationDate ?? '';

  return (
    <Alert data-testid="dispatch-at-issue-date">
      <AlertDescription className="space-y-2">
        <p>
          Este comprobante tiene líneas facturadas <strong>sin despacho registrado</strong>. Se
          pueden despachar con la fecha de operación calculada, o elegir una posterior donde el
          stock exista.
        </p>
        {suggestedDate !== undefined && (
          <p data-testid="dispatch-suggested-date">
            Comprobante reactivado: queda <strong>pendiente de despacho</strong>. La fecha sugerida
            es la del comprobante ({formatDate(suggestedDate)}), para que su salida quede en el
            kardex con esa fecha.
          </p>
        )}
        <label className="grid max-w-xs gap-1 text-sm font-medium">
          Fecha de despacho
          <Input
            type="date"
            value={dispatchDate ?? defaultFirstDate}
            onChange={(event) => {
              setDispatchDate(event.target.value || undefined);
            }}
            aria-label="Fecha de despacho"
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Default D-285:{' '}
          {defaultLines
            .map(
              (line) =>
                `Línea ${String(line.lineNumber)}: ${formatDate(defaultDates.get(line.lineNumber) ?? '')}`,
            )
            .join(' · ')}
          . El kardex debe quedar sin saldo negativo.
        </p>
        {planError !== null && (
          <p data-testid="dispatch-plan-error" className="text-sm text-destructive">
            {planError}
          </p>
        )}
        {planError === null && !planReady && (
          <p className="text-xs text-muted-foreground">Recalculando el plan para esa fecha…</p>
        )}
        <ul
          className={cn('list-disc pl-5 text-sm', !planReady && 'opacity-60')}
          aria-busy={!planReady && planError === null}
        >
          {lines.map((l) => (
            <li key={l.lineNumber}>
              Línea {l.lineNumber} · {l.sku} · {l.qty}
              {planError === null && `: ${ACTION_LABELS[l.action]}`}
              {planError === null && l.action === 'REVIEW' && l.reason ? ` — ${l.reason}` : ''}
              {planError === null && l.firstValidDate
                ? ` · Primera fecha válida: ${formatDate(l.firstValidDate)}`
                : ''}
              {planError === null && l.restorableReservation !== null && (
                // D-379: la reserva de lo fabricado se liberó a mano; se repone desde el pedido.
                <span data-testid="dispatch-restore-reservation" className="block">
                  La reserva de esta línea se liberó a mano.{' '}
                  <Link
                    href={restoreReservationHref(
                      l.restorableReservation.salesOrderId,
                      l.restorableReservation.reservationId,
                    )}
                    className={LINK_CLASSNAME}
                  >
                    Restaurar reserva
                  </Link>{' '}
                  y volver acá para despacharla.
                </span>
              )}
            </li>
          ))}
        </ul>
        {/* Mientras se recalcula, o con la fecha rechazada, el botón sigue a la vista pero
            inactivo: el plan que se ve no es el de la fecha del campo. */}
        {(actionable || !planReady) && (
          <Button
            size="sm"
            disabled={!actionable}
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
