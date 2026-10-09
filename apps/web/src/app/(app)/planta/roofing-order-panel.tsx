'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage, toast } from '@/lib/notify';
import {
  MAX_ORDER_STRIPS,
  Role,
  toDecimal,
  type ProductionOrderDto,
  type RawMaterialWarningDto,
  type RoofingBatchOrderDto,
  type RoofingCoilOptionDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { invalidateProduction } from '@/lib/production-queries';
import { useSession } from '@/lib/session';
import { LINK_CLASSNAME } from '@/lib/utils';
import { OrderPriorityControl } from '@/components/production-queue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { PLANT_ORDER_STATE_TONE, PRIORITY_TONE } from '@/components/status-tone';
import { CoilPicker } from './coil-picker';
import { ProduceAccessory } from './produce-accessory';
import { ProduceBlocks } from './produce-blocks';

/**
 * El ciclo completo de **una** orden de coberturas dentro del espacio de producción
 * (D-155, rehecho por D-159, D-191 y cc35).
 *
 * **cc35 (modelo M):** se produce bobina por bobina, en el orden en que se montaron. Una
 * cobertura a medida o una plancha de catálogo escribe sus bloques en el borrador de la orden
 * (`ProduceBlocks`); un accesorio, sin plan de corte, escribe metros de bobina por bloque
 * (`ProduceAccessory`, D-551).
 *
 * Lo que **no** cambió: el tope de metros del plan sigue siendo duro (D-146) y las desviaciones del
 * kilo declarado y el faltante del agregado siguen siendo avisos (D-154).
 */

/**
 * Lo que la última operación de una orden dejó dicho, y que sigue a la vista después de
 * guardar. Son avisos (D-154) y no bloquean nada.
 */
export interface SavedNotes {
  /** Faltantes del agregado que devolvió el API. */
  pool: RawMaterialWarningDto[];
  /** Una nota retenida para que no desaparezca al limpiar el campo. */
  note: string | null;
}

export const NO_NOTES: SavedNotes = { pool: [], note: null };

export function RoofingOrderPanel({
  order,
  asList,
  refreshing,
  notes,
  operationDate,
  onOperationDate,
  onNotes,
}: {
  order: RoofingBatchOrderDto;
  /** El picker dejó de ser pestañas; el panel tiene que dejar de ser `tabpanel` con él. */
  asList: boolean;
  /** La lista de órdenes se está refrescando: bloquea los envíos. */
  refreshing: boolean;
  notes: SavedNotes;
  operationDate: string | undefined;
  onOperationDate: (value: string | undefined) => void;
  onNotes: (next: SavedNotes) => void;
}) {
  const queryClient = useQueryClient();
  const { user } = useSession();

  const invalidate = () => {
    invalidateProduction(queryClient, order.orderId);
    void queryClient.invalidateQueries({ queryKey: ['roofing-coils'] });
  };

  /** D-193: reabrir mueve el kardex de la bobina; las pantallas de bobinas tienen que enterarse. */
  const invalidateReopened = () => {
    void queryClient.invalidateQueries({ queryKey: ['coil'] });
    void queryClient.invalidateQueries({ queryKey: ['coils'] });
  };

  const options = useQuery({
    queryKey: ['roofing-coils', order.productId, order.reservationId],
    queryFn: () =>
      api<RoofingCoilOptionDto[]>(
        `/production/roofing/coils?productId=${order.productId}` +
          (order.reservationId === null ? '' : `&reservationId=${order.reservationId}`) +
          // D-193: también las cerradas, que se montan reabriéndolas con confirmación.
          '&includeClosed=true',
      ),
  });

  const mount = useMutation({
    // D-192: una o varias bobinas en una sola operación.
    mutationFn: ({
      coilIds,
      reopen,
    }: {
      coilIds: string[];
      reopen?: { coilIds: string[]; reason: string; physicalKg?: string };
    }) =>
      api<ProductionOrderDto>(`/production/roofing/${order.orderId}/coils`, {
        method: 'POST',
        body: {
          ...(coilIds.length === 1 ? { coilId: coilIds[0] } : { coilIds }),
          ...(reopen ? { reopenCoilIds: reopen.coilIds, reopenReason: reopen.reason } : {}),
          // cc29 (D-466): el peso físico de una terminada con el kardex en 0.
          ...(reopen?.physicalKg ? { physicalKg: reopen.physicalKg } : {}),
        },
      }),
    onSuccess: (updated, { coilIds, reopen }) => {
      if (reopen) invalidateReopened();
      toast.success(
        coilIds.length === 1
          ? 'Bobina montada en la roladora'
          : `${String(coilIds.length)} bobinas montadas en la roladora`,
      );
      onNotes({ pool: updated.rawMaterialWarnings ?? [], note: null });
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err, 'No se pudo montar la bobina')),
  });

  const release = useMutation({
    mutationFn: (consumptionId: string) =>
      api<ProductionOrderDto>(
        `/production/roofing/${order.orderId}/coils/${consumptionId}/release`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      toast.success('Bobina bajada de la orden');
      onNotes(NO_NOTES);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err, 'No se pudo bajar la bobina')),
  });

  const state = stateOf(order);
  const full = order.coils.length >= MAX_ORDER_STRIPS;
  const mountControl = full ? (
    <span className="text-xs text-destructive">
      La orden ya tiene las {MAX_ORDER_STRIPS} bobinas que admite a la vez: ciérrala o baja alguna.
    </span>
  ) : (
    <CoilPicker
      orderCode={order.code}
      productSku={order.productSku}
      options={options.data ?? []}
      loading={options.isPending}
      failed={options.isError}
      mountedCount={order.coils.length}
      remainingMeters={order.remainingMeters}
      productName={order.productName}
      pending={mount.isPending}
      onMount={(coilIds, reopen) => {
        mount.mutate({ coilIds, ...(reopen ? { reopen } : {}) });
      }}
    />
  );
  const shared = {
    order,
    refreshing: refreshing || mount.isPending,
    operationDate,
    onOperationDate,
    onUpdated: (updated: ProductionOrderDto | null) => {
      onNotes({ pool: updated?.rawMaterialWarnings ?? [], note: null });
    },
    mountButton: mountControl,
    releaseCoil: (consumptionId: string) => {
      release.mutate(consumptionId);
    },
    releasing: release.isPending,
  };

  return (
    // Con la forma de lista, `tabpanel` sería un huérfano: no hay ningún `tablist` que lo
    // contenga y `aria-labelledby` apuntaría a un botón que ya no se anuncia como pestaña.
    <section
      role={asList ? undefined : 'tabpanel'}
      id={`panel-${order.orderId}`}
      aria-labelledby={`tab-${order.orderId}`}
      className="grid gap-4"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono font-semibold">{order.code}</span>
        <StateBadge state={state} />
        <span className="text-muted-foreground">
          {order.productSku} · {order.productName}
          {order.salesOrderCode !== null && order.salesOrderId !== null && (
            <>
              {' · '}
              <Link href={`/pedidos/${order.salesOrderId}`} className={LINK_CLASSNAME}>
                {order.salesOrderCode}
              </Link>
            </>
          )}
          {order.customerName !== null && <> · {order.customerName}</>}
          {' · '}
          <Link href={`/produccion/${order.orderId}`} className={LINK_CLASSNAME}>
            Ver el detalle de la orden
          </Link>
        </span>
        {order.priority && <Badge variant={PRIORITY_TONE}>Prioridad</Badge>}
        {/* D-189: la prioridad es de la orden; se fija desde su propio panel. */}
        {user.role === Role.ADMINISTRADOR && (
          <span className="ml-auto">
            <OrderPriorityControl
              orderId={order.orderId}
              orderCode={order.code}
              priority={order.priority}
            />
          </span>
        )}
      </div>

      {(notes.pool.length > 0 || notes.note !== null) && (
        <Alert>
          <AlertDescription className="grid gap-1">
            {notes.note !== null && <span>⚠ {notes.note}</span>}
            {notes.pool.map((w, i) => (
              <span key={i}>⚠ {w.message}</span>
            ))}
          </AlertDescription>
        </Alert>
      )}

      {order.isAccessory ? <ProduceAccessory {...shared} /> : <ProduceBlocks {...shared} />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Estado de una orden, que es lo que la pestaña tiene que decir de un vistazo
// ---------------------------------------------------------------------------

export type OrderState = 'sin-plan' | 'sin-bobina' | 'lista' | 'reportada';

const STATE_LABELS: Record<OrderState, string> = {
  'sin-plan': 'Sin plan',
  'sin-bobina': 'Sin bobina',
  lista: 'Lista',
  reportada: 'Reportada',
};

/**
 * El estado va en este orden y no en otro.
 *
 * **«Sin plan» va primero**, y no por prolijidad: una orden sin plan de corte tiene
 * `remainingMeters = "0.000"`, o sea la misma cifra que una que ya produjo todo. Sin
 * distinguirlas, la pestaña decía **«Reportada»** y la barra la contaba entre las cubiertas
 * sobre una orden que no produjo ni un metro — y desde D-146 el tope duro además no la deja
 * reportar nada hasta que alguien le escriba el plan.
 *
 * Después «reportada», que gana aunque la bobina ya se haya bajado —el plan está cubierto y
 * no hay nada más que hacer—, y «sin bobina», que es lo que separa una orden que se puede
 * reportar de una que primero necesita material.
 */
export function stateOf(order: RoofingBatchOrderDto): OrderState {
  if (order.planItems.length === 0) return 'sin-plan';
  if (toDecimal(order.remainingMeters).lte(0)) return 'reportada';
  return order.coils.length === 0 ? 'sin-bobina' : 'lista';
}

export function StateBadge({ state }: { state: OrderState }) {
  return <Badge variant={PLANT_ORDER_STATE_TONE[state]}>{STATE_LABELS[state]}</Badge>;
}

export function MiniStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'alert' | 'strong';
}) {
  return (
    <div className="bg-background px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          tone === 'alert'
            ? 'text-lg font-semibold tabular-nums text-destructive'
            : 'text-lg font-semibold tabular-nums'
        }
      >
        {value}
      </p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
