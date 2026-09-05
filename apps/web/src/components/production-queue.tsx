'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  describePieces,
  type ProductionQueueEntryDto,
  type QueueSemaphore,
  type SalesOrderDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatQty, queueAgeLabel, todayIso } from '@/lib/format';
import { invalidateSales } from '@/lib/sales-queries';
import { ReasonDialog } from '@/components/reason-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * La cola de producción (RF-37, D-092..D-096): pedidos confirmados de coberturas contra
 * pedido, con reserva de bobina activa y sin OP viva todavía. Vive acá y no en
 * `roofing-terminal.tsx` porque la consumen dos pantallas —`/planta` la usa como entrada al
 * flujo de Fase 6, `/produccion` la expone en vista de administración— y ninguna de las dos
 * es dueña de la otra.
 */
export function useProductionQueue(
  options: { enabled?: boolean } = {},
): UseQueryResult<ProductionQueueEntryDto[]> {
  return useQuery({
    queryKey: ['production-queue'],
    queryFn: () => api<ProductionQueueEntryDto[]>('/sales/orders/queue'),
    enabled: options.enabled ?? true,
  });
}

const SEMAPHORE_LABEL: Record<QueueSemaphore, string> = {
  VENCIDO: 'Vencido',
  PROXIMO: 'Próximo (<48 h)',
  A_TIEMPO: 'A tiempo',
  SIN_FECHA: 'Sin fecha',
};

const SEMAPHORE_VARIANT: Record<
  QueueSemaphore,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  VENCIDO: 'destructive',
  PROXIMO: 'default',
  A_TIEMPO: 'secondary',
  SIN_FECHA: 'outline',
};

/** Lo que toda tarjeta de la cola muestra, sin importar quién la use ni qué botón le ponga. */
export function QueueEntrySummary({ entry }: { entry: ProductionQueueEntryDto }) {
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-medium">{entry.salesOrderCode}</span>
        {entry.priority && <Badge>Prioridad</Badge>}
        <Badge variant={SEMAPHORE_VARIANT[entry.semaphore]}>
          {SEMAPHORE_LABEL[entry.semaphore]}
        </Badge>
      </div>
      <div className="text-sm">{entry.customerName}</div>
      <div className="text-xs text-muted-foreground">
        {entry.productSku} — {entry.productName}
      </div>
      <div className="text-xs text-muted-foreground">
        {describePieces(entry.pieces)}
        {entry.theoreticalKg !== null && <> · {formatQty(entry.theoreticalKg, 'kg')} teóricos</>}
      </div>
      <div className="text-xs text-muted-foreground">
        Prometida: {entry.promisedDeliveryDate ? formatDate(entry.promisedDeliveryDate) : 'sin fecha'}{' '}
        · en cola desde {queueAgeLabel(entry.createdAt)}
      </div>
      {entry.priority && (
        <div className="text-xs text-muted-foreground">
          {entry.priorityReason}
          {entry.priorityByName ? ` — ${entry.priorityByName}` : ''}
        </div>
      )}
    </div>
  );
}

/** Lo mínimo que hace falta para editar prioridad/fecha de un pedido, sin atarse a la cola. */
export interface QueueAdminTarget {
  salesOrderId: string;
  salesOrderCode: string;
  customerName: string;
  priority: boolean;
  promisedDeliveryDate: string | null;
}

/**
 * Controles de ADMINISTRADOR sobre un pedido (D-094, D-096): prioridad manual con motivo
 * obligatorio en los dos sentidos, y la fecha prometida. Los usa tanto `/produccion` (una
 * fila de la cola) como `/pedidos/[id]` (el propio pedido) — `/planta` no los monta.
 */
export function QueueAdminControls({ entry }: { entry: QueueAdminTarget }) {
  const queryClient = useQueryClient();
  const [reasonOpen, setReasonOpen] = useState(false);

  const setPriority = useMutation({
    mutationFn: (input: { priority: boolean; reason: string }) =>
      api<SalesOrderDto>(`/sales/orders/${entry.salesOrderId}/priority`, {
        method: 'PATCH',
        body: input,
      }),
    onSuccess: () => {
      toast.success(entry.priority ? 'Prioridad quitada' : 'Pedido priorizado');
      invalidateSales(queryClient, { orderId: entry.salesOrderId });
      setReasonOpen(false);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo cambiar la prioridad'),
  });

  const setDate = useMutation({
    mutationFn: (promisedDeliveryDate: string | null) =>
      api<SalesOrderDto>(`/sales/orders/${entry.salesOrderId}/promised-delivery-date`, {
        method: 'PATCH',
        body: { promisedDeliveryDate },
      }),
    onSuccess: () => {
      invalidateSales(queryClient, { orderId: entry.salesOrderId });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo cambiar la fecha'),
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="date"
        aria-label={`Fecha prometida del pedido ${entry.salesOrderCode}`}
        className="h-9 w-40"
        max="2999-12-31"
        min={todayIso()}
        defaultValue={entry.promisedDeliveryDate ?? ''}
        disabled={setDate.isPending}
        onBlur={(e) => {
          const value = e.target.value;
          if (value === (entry.promisedDeliveryDate ?? '')) return;
          setDate.mutate(value === '' ? null : value);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={setPriority.isPending}
        onClick={() => {
          setReasonOpen(true);
        }}
      >
        {entry.priority ? 'Quitar prioridad' : 'Priorizar'}
      </Button>
      <ReasonDialog
        open={reasonOpen}
        onOpenChange={setReasonOpen}
        title={entry.priority ? 'Quitar prioridad' : 'Priorizar pedido'}
        description={`Pedido ${entry.salesOrderCode} — ${entry.customerName}. Queda registrado en la auditoría (RF-95).`}
        confirmLabel={entry.priority ? 'Quitar prioridad' : 'Priorizar'}
        pending={setPriority.isPending}
        onConfirm={(reason) => {
          setPriority.mutate({ priority: !entry.priority, reason });
        }}
      />
    </div>
  );
}
