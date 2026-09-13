'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ProductionOrderDto, RoofingBatchOrderDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { invalidateProduction } from '@/lib/production-queries';
import { ReasonDialog } from '@/components/reason-dialog';
import { Button } from '@/components/ui/button';

/**
 * F8-S3b/M2: la prioridad manual se asigna **al pedido** desde su vista de producción y se
 * propaga a sus órdenes.
 *
 * El portador sigue siendo la orden (D-189, sin migración): esto no es un endpoint nuevo sino
 * el mismo `PATCH /production/roofing/:id/priority` de siempre, una vez por cada orden de
 * coberturas abierta del pedido que todavía no está en el estado pedido. Cada llamada deja su
 * propio asiento de auditoría con el mismo motivo (RF-95). Solo coberturas: la prioridad de
 * D-189 no existe en perfiles.
 *
 * Las llamadas van **en serie** y no en paralelo: si una falla (la orden se cerró entre la
 * lectura y el clic), el mensaje dice cuántas quedaron hechas y cuál falló, en vez de un
 * resultado a medias que nadie sabe describir.
 */
export function PedidoPriorityControl({
  salesOrderCode,
  orders,
}: {
  salesOrderCode: string;
  /** Las órdenes de coberturas abiertas del pedido. */
  orders: readonly RoofingBatchOrderDto[];
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  // El sentido se conserva al cerrar: sin esto el título del diálogo cambiaba durante la
  // animación de salida (el mismo parpadeo que F8-S2b corrigió en los diálogos del pedido).
  const [target, setTarget] = useState(true);
  const prioritized = orders.filter((o) => o.priority).length;

  const apply = useMutation({
    mutationFn: async (input: { priority: boolean; reason: string }) => {
      const pendingOrders = orders.filter((o) => o.priority !== input.priority);
      let done = 0;
      for (const order of pendingOrders) {
        try {
          await api<ProductionOrderDto>(`/production/roofing/${order.orderId}/priority`, {
            method: 'PATCH',
            body: input,
          });
          done += 1;
        } catch (err) {
          const detail = err instanceof ApiError ? err.message : 'error desconocido';
          throw new Error(
            `${String(done)} de ${String(pendingOrders.length)} órdenes actualizadas; ${order.code} falló: ${detail}`,
          );
        }
      }
      return { priority: input.priority, count: done };
    },
    onSuccess: ({ priority, count }) => {
      toast.success(
        priority
          ? `${salesOrderCode} priorizado (${String(count)} ${count === 1 ? 'orden' : 'órdenes'})`
          : `${salesOrderCode}: prioridad quitada (${String(count)} ${count === 1 ? 'orden' : 'órdenes'})`,
      );
      setOpen(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'No se pudo cambiar la prioridad');
    },
    onSettled: () => {
      invalidateProduction(queryClient);
    },
  });

  if (orders.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {prioritized < orders.length && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={apply.isPending}
            onClick={() => {
              setTarget(true);
              setOpen(true);
            }}
          >
            Priorizar pedido
          </Button>
        )}
        {prioritized > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={apply.isPending}
            onClick={() => {
              setTarget(false);
              setOpen(true);
            }}
          >
            Quitar prioridad al pedido
          </Button>
        )}
      </div>
      <ReasonDialog
        open={open}
        onOpenChange={setOpen}
        title={target ? `Priorizar ${salesOrderCode}` : `Quitar prioridad a ${salesOrderCode}`}
        description={`Se aplica a ${
          target ? String(orders.length - prioritized) : String(prioritized)
        } de las ${String(orders.length)} órdenes de coberturas abiertas del pedido y las mueve en la cola de producción. Queda registrado en la auditoría (RF-95).`}
        confirmLabel={target ? 'Priorizar' : 'Quitar prioridad'}
        pending={apply.isPending}
        onConfirm={(reason) => {
          apply.mutate({ priority: target, reason });
        }}
      />
    </>
  );
}
