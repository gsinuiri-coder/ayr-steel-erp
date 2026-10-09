'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage, toast } from '@/lib/notify';
import {
  MAX_ORDER_STRIPS,
  MAX_SCRAP_RATIO_WITHOUT_REASON,
  equivalentMeters,
  Role,
  sum,
  toDecimal,
  type PlantClosePreviewDto,
  type ProductionOrderDto,
  type RawMaterialWarningDto,
  type RoofingBatchCoilDto,
  type RoofingBatchOrderDto,
  type RoofingCoilOptionDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatQtyAsIs } from '@/lib/format';
import { invalidateProduction } from '@/lib/production-queries';
import { useSession } from '@/lib/session';
import { LINK_CLASSNAME } from '@/lib/utils';
import { OrderPriorityControl } from '@/components/production-queue';
import { ClosePreviewDialog } from '@/components/production/close-preview-dialog';
import { ReasonDialog } from '@/components/reason-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { PLANT_ORDER_STATE_TONE, PRIORITY_TONE } from '@/components/status-tone';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AccessoryReportCard } from './accessory-report-card';
import { CoilPicker } from './coil-picker';
import { ProduceBlocks } from './produce-blocks';

/**
 * El ciclo completo de **una** orden de coberturas dentro del espacio de producción
 * (D-155, rehecho por D-159, D-191 y cc35).
 *
 * - **cc35 (modelo M):** una cobertura a medida o una plancha de catálogo se produce bobina por
 *   bobina, en el orden en que se montaron (`ProduceBlocks`). El borrador de D-191 sigue debajo,
 *   pero el supervisor no lo ve como tal: lo que escribe en cada bloque se guarda solo.
 * - El accesorio (D-343) sigue reportando metros de bobina directos (`AccessoryReportCard`).
 *
 * Lo que **no** cambió: el tope de metros del plan sigue siendo duro (D-146) y las desviaciones del
 * kilo declarado y el faltante del agregado siguen siendo avisos (D-154).
 */

/** Lo que se está escribiendo en una orden. Vive **en el padre**, indexado por orden. */
export interface OrderDraft {
  /** Accesorio: la bobina elegida cuando hay varias montadas. */
  coilId: string;
  /** Accesorio, D-089: kilos que la bobina consumió en **toda** la corrida. */
  closeKg: string;
}

export const EMPTY_DRAFT: OrderDraft = {
  closeKg: '',
  coilId: '',
};

/**
 * Lo que la última operación de una orden dejó dicho, y que sigue a la vista después de
 * guardar. Los dos son avisos (D-154) y ninguno bloquea nada.
 */
export interface SavedNotes {
  /** Faltantes del agregado que devolvió el API. */
  pool: RawMaterialWarningDto[];
  /** La desviación del kg declarado, retenida para que no desaparezca al limpiar el campo. */
  note: string | null;
}

export const NO_NOTES: SavedNotes = { pool: [], note: null };

/**
 * F8-S3c/M3: metro lineal equivalente de lo que le queda a una bobina montada (D-116).
 * Presentación pura: la asignación real sigue en kg.
 */
function equivalentMetersOf(coil: RoofingBatchCoilDto): string | null {
  return equivalentMeters(coil, coil.remainingKg)?.toFixed(3) ?? null;
}

export function RoofingOrderPanel({
  order,
  asList,
  refreshing,
  draft,
  notes,
  operationDate,
  onOperationDate,
  onDraft,
  onNotes,
}: {
  order: RoofingBatchOrderDto;
  /** El picker dejó de ser pestañas; el panel tiene que dejar de ser `tabpanel` con él. */
  asList: boolean;
  /** La lista de órdenes se está refrescando: bloquea los envíos. */
  refreshing: boolean;
  draft: OrderDraft;
  notes: SavedNotes;
  operationDate: string | undefined;
  onOperationDate: (value: string | undefined) => void;
  onDraft: (patch: Partial<OrderDraft>) => void;
  onNotes: (next: SavedNotes) => void;
}) {
  const queryClient = useQueryClient();
  const { user } = useSession();
  /** Motivo del despunte cuando el cierre del accesorio lo exige (D-089). */
  const [askingReason, setAskingReason] = useState(false);
  const [reasonToSend, setReasonToSend] = useState<string | null>(null);
  const [closePreview, setClosePreview] = useState<{
    preview: PlantClosePreviewDto;
    reason: string | null;
  } | null>(null);

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
      onDraft({ coilId: '' });
      onNotes(NO_NOTES);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err, 'No se pudo bajar la bobina')),
  });

  /** El cierre suelto del accesorio, el mismo cuerpo para su vista previa (D-453). */
  const closeOnlyBody = (reason: string | null) => ({
    ...(reason ? { reason } : {}),
    ...(draft.closeKg.trim() ? { consumedKg: toDecimal(draft.closeKg.trim()).toFixed(3) } : {}),
    operationDate,
  });
  const closeOnly = useMutation({
    mutationFn: (reason: string | null) =>
      api<ProductionOrderDto>(`/production/roofing/${order.orderId}/close`, {
        method: 'POST',
        body: closeOnlyBody(reason),
      }),
    onSuccess: (updated) => {
      toast.success(
        `${order.code}: orden cerrada con ${formatQtyAsIs(updated.scrapKg ?? '0.000', 'kg')} de despunte`,
      );
      setReasonToSend(null);
      invalidate();
    },
    onError: (err) => {
      if (err instanceof ApiError && /motivo/i.test(err.message)) {
        setAskingReason(true);
        return;
      }
      toast.error(errorMessage(err, 'No se pudo cerrar la orden'));
    },
  });
  const previewCloseOnly = useMutation({
    mutationFn: (reason: string | null) =>
      api<PlantClosePreviewDto>(`/production/roofing/${order.orderId}/close/preview`, {
        method: 'POST',
        body: closeOnlyBody(reason),
      }),
    onSuccess: (preview, reason) => {
      setClosePreview({ preview, reason });
    },
    onError: (err) => {
      if (err instanceof ApiError && /motivo/i.test(err.message)) {
        setAskingReason(true);
        return;
      }
      setReasonToSend(null);
      toast.error(errorMessage(err, 'No se pudo cerrar la orden'));
    },
  });

  const liveCoils = order.coils;
  const state = stateOf(order);
  const full = liveCoils.length >= MAX_ORDER_STRIPS;
  const canCloseOnly = toDecimal(order.reportedKg).gt(0);
  const busy =
    closeOnly.isPending ||
    previewCloseOnly.isPending ||
    mount.isPending ||
    release.isPending ||
    refreshing;

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
      mountedCount={liveCoils.length}
      remainingMeters={order.remainingMeters}
      productName={order.productName}
      pending={mount.isPending}
      onMount={(coilIds, reopen) => {
        mount.mutate({ coilIds, ...(reopen ? { reopen } : {}) });
      }}
    />
  );

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

      {!order.isAccessory ? (
        <ProduceBlocks
          order={order}
          refreshing={refreshing || mount.isPending}
          operationDate={operationDate}
          onOperationDate={onOperationDate}
          onUpdated={(updated) => {
            onNotes({ pool: updated?.rawMaterialWarnings ?? [], note: null });
          }}
          mountButton={mountControl}
          releaseCoil={(consumptionId) => {
            release.mutate(consumptionId);
          }}
          releasing={release.isPending}
        />
      ) : (
        <>
          <Card>
            <CardContent className="grid gap-3 pt-4">
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
                <MiniStat label="ML del pedido" value={`${order.planMeters} m`} />
                <MiniStat label="ML reportado" value={`${order.reportedMeters} m`} />
                <MiniStat
                  label="ML restante"
                  value={`${order.remainingMeters} m`}
                  tone={toDecimal(order.remainingMeters).lte(0) ? 'alert' : 'strong'}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                {/* D-343: un accesorio no tiene plan de largos; lo que falta son metros de bobina. */}
                {toDecimal(order.remainingMeters).gt(0)
                  ? `Faltan ${order.remainingMeters} m de bobina`
                  : 'Ya se reportaron los metros encargados.'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>
                {liveCoils.length > 1
                  ? `Bobinas montadas (${String(liveCoils.length)})`
                  : 'Bobina montada'}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {liveCoils.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  La orden no tiene ninguna bobina montada: monta una para poder reportar.
                </p>
              )}
              {liveCoils.map((c) => {
                const remainingMeters = equivalentMetersOf(c);
                return (
                  <div
                    key={c.coilId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <div>
                      <div className="font-mono font-medium">{c.coilCode}</div>
                      <div className="text-sm text-muted-foreground">
                        {c.widthMm} mm · pendiente {formatQtyAsIs(c.remainingKg, 'kg')}
                        {remainingMeters !== null && (
                          <> · ≈ {formatQtyAsIs(remainingMeters, 'm')}</>
                        )}
                      </div>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {formatQtyAsIs(order.reportedMeters, 'm')} de la orden ·{' '}
                      {formatQtyAsIs(c.consumedKg, 'kg')} consumidos de esta bobina
                    </div>
                    <div className="flex items-center gap-2">
                      {liveCoils.length > 1 && (
                        <Button
                          variant={draft.coilId === c.coilId ? 'default' : 'outline'}
                          className="h-11"
                          aria-label={`Reportar desde la bobina ${c.coilCode}`}
                          onClick={() => {
                            onDraft({ coilId: c.coilId });
                          }}
                        >
                          {draft.coilId === c.coilId ? 'Elegida' : 'Usar esta'}
                        </Button>
                      )}
                      {/* Una bobina que ya roló no se baja: hay que revertir esos reportes
                          primero (RF-33). */}
                      <Button
                        variant="outline"
                        className="h-11"
                        aria-label={`Bajar la bobina ${c.coilCode} de ${order.code}`}
                        disabled={release.isPending || toDecimal(c.consumedKg).gt(0)}
                        onClick={() => {
                          release.mutate(c.consumptionId);
                        }}
                      >
                        {toDecimal(c.consumedKg).gt(0) ? 'Ya roló' : 'Bajar'}
                      </Button>
                    </div>
                  </div>
                );
              })}
              {mountControl}
            </CardContent>
          </Card>

          {/* D-343: un accesorio reporta metros de bobina directos, sin largos ni borrador. */}
          <AccessoryReportCard
            order={order}
            coilId={draft.coilId === '' ? undefined : draft.coilId}
            operationDate={operationDate}
            closeKg={draft.closeKg}
            onCloseKg={(closeKg) => {
              setReasonToSend(null);
              onDraft({ closeKg });
            }}
            disabled={busy}
            canCloseOnly={canCloseOnly}
            closing={closeOnly.isPending}
            onCloseOnly={() => {
              previewCloseOnly.mutate(reasonToSend);
            }}
            onDone={(updated) => {
              onNotes({ pool: updated.rawMaterialWarnings ?? [], note: null });
              onDraft({ closeKg: '' });
              invalidate();
            }}
          />

          <ReasonDialog
            open={askingReason}
            onOpenChange={(open) => {
              if (!open) setReasonToSend(null);
              setAskingReason(open);
            }}
            title="Cerrar con despunte alto"
            description={`Lo declarado deja más del ${String(MAX_SCRAP_RATIO_WITHOUT_REASON * 100)} % de despunte: la diferencia sale del inventario y su costo se reparte entre el producto bueno. Si el material está entero, vuelve y declara menos kilos consumidos. Si de verdad salió como despunte, explica por qué.`}
            confirmLabel="Cerrar la orden"
            pending={busy}
            onConfirm={(reason: string) => {
              setReasonToSend(reason);
              setAskingReason(false);
              previewCloseOnly.mutate(reason);
            }}
          />

          <ClosePreviewDialog
            preview={closePreview?.preview ?? null}
            mountedKg={sum(
              liveCoils.map((c) => toDecimal(c.consumedKg).plus(c.remainingKg)),
            ).toFixed(3)}
            title={`Cerrar ${order.code} sin reportar más`}
            confirmLabel="Cerrar la orden"
            pending={closeOnly.isPending}
            onCancel={() => {
              setReasonToSend(null);
              setClosePreview(null);
            }}
            onConfirm={() => {
              if (closePreview === null) return;
              closeOnly.mutate(closePreview.reason, {
                onSettled: () => {
                  setClosePreview(null);
                },
              });
            }}
          />
        </>
      )}
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
