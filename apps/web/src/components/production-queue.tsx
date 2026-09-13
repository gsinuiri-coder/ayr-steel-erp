'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  describePieces,
  type LineWithoutOrderDto,
  type ProductionOrderDto,
  type ProductionQueueEntryDto,
  type QueueSemaphore,
  type SalesOrderDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatQty, queueAgeLabel, todayIso } from '@/lib/format';
import { invalidateProduction } from '@/lib/production-queries';
import { invalidateSales } from '@/lib/sales-queries';
import type { StatusTone } from '@/components/status-tone';
import { ReasonDialog } from '@/components/reason-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * La cola de producción (RF-37, D-189): las órdenes de coberturas **no iniciadas**, en el
 * orden que decide `compareQueueRank` en el API — el mismo que usa `/planta`. Vive acá y no en
 * `/planta` porque también la leen el menú (el contador) y el detalle del pedido.
 */
export function useProductionQueue(
  options: { enabled?: boolean } = {},
): UseQueryResult<ProductionQueueEntryDto[]> {
  return useQuery({
    queryKey: ['production-queue'],
    queryFn: () => api<ProductionQueueEntryDto[]>('/production/roofing/queue'),
    enabled: options.enabled ?? true,
  });
}

/**
 * Líneas de pedido que reservan materia prima y no tienen orden viva (D-093). Desde D-189 no
 * son la cola: es lo que perdió su orden, y desde donde se vuelve a abrir una.
 */
export function useLinesWithoutOrder(): UseQueryResult<LineWithoutOrderDto[]> {
  return useQuery({
    queryKey: ['lines-without-order'],
    queryFn: () => api<LineWithoutOrderDto[]>('/sales/orders/lines-without-order'),
  });
}

export const SEMAPHORE_LABEL: Record<QueueSemaphore, string> = {
  VENCIDO: 'Vencida',
  PROXIMO: 'Próxima (<48 h)',
  A_TIEMPO: 'A tiempo',
  SIN_FECHA: 'Sin fecha',
};

/**
 * D-180: el semáforo de la fecha prometida, con los mismos cuatro tonos que el resto del
 * sistema. Un semáforo es exactamente el caso para el que existe `warning`.
 */
export const SEMAPHORE_VARIANT: Record<QueueSemaphore, StatusTone> = {
  VENCIDO: 'destructive',
  PROXIMO: 'warning',
  A_TIEMPO: 'done',
  SIN_FECHA: 'outline',
};

/**
 * Una entrada de la cola, completa: OP, pedido y cliente, producto (SKU con color y espesor),
 * ML del plan, fecha compromiso, prioridad y la marca de vencida. Toda la tarjeta es el enlace
 * al workspace de **esa** orden (D-189): el clic lleva a producirla, no a buscarla.
 */
export function QueueEntryLink({
  entry,
  href,
  onSelect,
  selected = false,
}: {
  entry: ProductionQueueEntryDto;
  /** A dónde lleva el clic. Sin `onSelect`, navega; con `onSelect`, lo resuelve la pantalla. */
  href: string;
  onSelect?: (orderId: string) => void;
  selected?: boolean;
}) {
  const className = `block rounded-lg border p-3 text-left hover:bg-muted ${
    selected ? 'border-primary bg-primary/5' : ''
  }`;
  const body = <QueueEntrySummary entry={entry} />;
  if (onSelect) {
    return (
      <button
        type="button"
        aria-current={selected}
        className={`w-full ${className}`}
        onClick={() => {
          onSelect(entry.orderId);
        }}
      >
        {body}
      </button>
    );
  }
  return (
    <Link href={href} className={className}>
      {body}
    </Link>
  );
}

export function QueueEntrySummary({ entry }: { entry: ProductionQueueEntryDto }) {
  const spec = [
    entry.colorName ?? 'sin color',
    entry.thicknessMm === null ? null : `${entry.thicknessMm} mm`,
  ]
    .filter((s): s is string => s !== null)
    .join(' · ');
  return (
    <span className="grid gap-0.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono font-medium">
          <span className="sr-only">Abrir en producción </span>
          {entry.code}
        </span>
        {entry.priority && <Badge>Prioridad</Badge>}
        {entry.overdue && <Badge variant="destructive">Vencida</Badge>}
        {!entry.overdue && (
          <Badge variant={SEMAPHORE_VARIANT[entry.semaphore]}>
            {SEMAPHORE_LABEL[entry.semaphore]}
          </Badge>
        )}
        {entry.salesOrderCode !== null && (
          <span className="font-mono text-sm">{entry.salesOrderCode}</span>
        )}
        {entry.customerName !== null && <span className="text-sm">{entry.customerName}</span>}
      </span>
      <span className="text-xs text-muted-foreground">
        {entry.productSku} ({spec}) · {entry.planMeters} m del plan
        {entry.planItems.length > 0 && <> · {describePieces(entry.planItems)}</>}
        {entry.theoreticalKg !== null && <> · {formatQty(entry.theoreticalKg, 'kg')} teóricos</>} ·
        Compromiso:{' '}
        {entry.promisedDeliveryDate ? formatDate(entry.promisedDeliveryDate) : 'sin fecha'} · en
        cola desde {queueAgeLabel(entry.createdAt)}
      </span>
      {entry.priority && (
        <span className="text-xs text-muted-foreground">
          {entry.priorityReason}
          {entry.priorityByName ? ` — ${entry.priorityByName}` : ''}
        </span>
      )}
    </span>
  );
}

/**
 * Fecha prometida del pedido (D-096): después de creado, solo ADMINISTRADOR. Es del pedido
 * —es lo que se le prometió al cliente— y sus órdenes la heredan (D-189).
 */
export function PromisedDateControl({
  salesOrderId,
  salesOrderCode,
  promisedDeliveryDate,
}: {
  salesOrderId: string;
  salesOrderCode: string;
  promisedDeliveryDate: string | null;
}) {
  const queryClient = useQueryClient();
  const setDate = useMutation({
    mutationFn: (value: string | null) =>
      api<SalesOrderDto>(`/sales/orders/${salesOrderId}/promised-delivery-date`, {
        method: 'PATCH',
        body: { promisedDeliveryDate: value },
      }),
    onSuccess: () => {
      invalidateSales(queryClient, { orderId: salesOrderId });
      invalidateProduction(queryClient);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo cambiar la fecha'),
  });

  return (
    <Input
      type="date"
      aria-label={`Fecha prometida del pedido ${salesOrderCode}`}
      className="h-9 w-40"
      max="2999-12-31"
      min={todayIso()}
      defaultValue={promisedDeliveryDate ?? ''}
      disabled={setDate.isPending}
      onBlur={(e) => {
        const value = e.target.value;
        if (value === (promisedDeliveryDate ?? '')) return;
        setDate.mutate(value === '' ? null : value);
      }}
    />
  );
}

/**
 * Prioridad manual de una orden (D-094 → D-189): ADMINISTRADOR, con motivo obligatorio en los
 * dos sentidos. Queda en la auditoría (RF-95).
 */
export function OrderPriorityControl({
  orderId,
  orderCode,
  priority,
}: {
  orderId: string;
  orderCode: string;
  priority: boolean;
}) {
  const queryClient = useQueryClient();
  const [reasonOpen, setReasonOpen] = useState(false);
  const setPriority = useMutation({
    mutationFn: (input: { priority: boolean; reason: string }) =>
      api<ProductionOrderDto>(`/production/roofing/${orderId}/priority`, {
        method: 'PATCH',
        body: input,
      }),
    onSuccess: () => {
      toast.success(priority ? `${orderCode}: prioridad quitada` : `${orderCode} priorizada`);
      invalidateProduction(queryClient, orderId);
      setReasonOpen(false);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo cambiar la prioridad'),
  });

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`${priority ? 'Quitar prioridad a' : 'Priorizar'} ${orderCode}`}
        disabled={setPriority.isPending}
        onClick={() => {
          setReasonOpen(true);
        }}
      >
        {priority ? 'Quitar prioridad' : 'Priorizar'}
      </Button>
      <ReasonDialog
        open={reasonOpen}
        onOpenChange={setReasonOpen}
        title={priority ? `Quitar prioridad a ${orderCode}` : `Priorizar ${orderCode}`}
        description="Mueve la orden en la cola de producción. Queda registrado en la auditoría (RF-95)."
        confirmLabel={priority ? 'Quitar prioridad' : 'Priorizar'}
        pending={setPriority.isPending}
        onConfirm={(reason) => {
          setPriority.mutate({ priority: !priority, reason });
        }}
      />
    </>
  );
}
