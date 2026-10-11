'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  PRODUCTION_ORDER_STATUS_LABELS,
  toDecimal,
  type ProductionOrderListItemDto,
  type ReservationDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatQty } from '@/lib/format';
import { LINK_CLASSNAME } from '@/lib/utils';
import { PRODUCTION_ORDER_TONE } from '@/components/status-tone';
import { Badge } from '@/components/ui/badge';

/**
 * cc45 (tablero «Cambiar cantidad»): la línea del pedido con su orden y su avance —«OP-000130 En
 * proceso · registrado 224.000 m de 258.800 m»—, para decidir el cambio de cantidad mirando la
 * misma fila. Usa la misma consulta que la tarjeta «Órdenes de producción» (D-190), así que no
 * agrega pedidos al API; solo ADMINISTRADOR la lee (`GET /production` trae costos, §3.4).
 *
 * La orden se ata a su línea por su reserva: la reserva es el único vínculo entre producción y
 * ventas (D-054).
 */
export function useLineOrders(
  salesOrderId: string,
  reservations: readonly Pick<ReservationDto, 'id' | 'salesOrderItemId'>[],
  enabled: boolean,
): Map<string, ProductionOrderListItemDto[]> {
  const orders = useQuery({
    queryKey: ['production-orders', 'sales-order', salesOrderId],
    queryFn: () => api<ProductionOrderListItemDto[]>(`/production?salesOrderId=${salesOrderId}`),
    enabled,
  });
  const lineOf = new Map(reservations.map((r) => [r.id, r.salesOrderItemId]));
  const byLine = new Map<string, ProductionOrderListItemDto[]>();
  for (const o of [...(orders.data ?? [])].sort((a, b) => a.code.localeCompare(b.code))) {
    const line = o.reservationId ? lineOf.get(o.reservationId) : undefined;
    if (!line) continue;
    byLine.set(line, [...(byLine.get(line) ?? []), o]);
  }
  return byLine;
}

/** Cuánto del plan está registrado, de 0 a 100. */
export function progressPercent(reported: string, plan: string): number {
  const p = toDecimal(plan);
  if (p.lte(0)) return 0;
  return Math.min(100, toDecimal(reported).div(p).times(100).toNumber());
}

export function LineProductionInfo({ orders }: { orders: readonly ProductionOrderListItemDto[] }) {
  const shown = orders.filter((o) => o.status !== 'CANCELLED' && o.planMeters !== null);
  if (shown.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-1">
      {shown.map((o) => {
        const reported = o.planMetersReported ?? '0.000';
        const plan = o.planMeters ?? '0.000';
        return (
          <div key={o.id} className="flex flex-col gap-0.5 text-xs tabular-nums">
            <span>
              <Link href={`/produccion/${o.id}`} className={LINK_CLASSNAME}>
                {o.code}
              </Link>{' '}
              <Badge variant={PRODUCTION_ORDER_TONE[o.status]}>
                {o.status === 'DRAFT' ? 'En cola' : PRODUCTION_ORDER_STATUS_LABELS[o.status]}
              </Badge>{' '}
              · registrado {formatQty(reported, 'm')} de {formatQty(plan, 'm')}
            </span>
            <div
              className="h-1.5 w-64 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={`Avance de ${o.code}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progressPercent(reported, plan))}
            >
              <div
                className="h-full bg-primary"
                style={{ width: `${String(progressPercent(reported, plan))}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
