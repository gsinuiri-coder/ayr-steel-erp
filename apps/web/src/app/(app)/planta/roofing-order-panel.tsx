'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MAX_ORDER_STRIPS,
  MAX_SCRAP_RATIO_WITHOUT_REASON,
  Decimal,
  describePieces,
  kgPerMeter,
  piecesMeters,
  piecesTheoreticalKg,
  Role,
  roofingConsumptionDeviation,
  toDecimal,
  toFixedString,
  Unit,
  type ProductionOrderDto,
  type RawMaterialWarningDto,
  type RoofingBatchCoilDto,
  type RoofingBatchOrderDto,
  type RoofingCoilOptionDto,
  type RoofingPieceDto,
  type RoofingReportDraftDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatQty } from '@/lib/format';
import { EMPTY_PIECE_ROW, mmToMeters, parsePieceRows, type PieceRow } from '@/lib/pieces';
import { invalidateProduction } from '@/lib/production-queries';
import { useBackdateConfirm } from '@/lib/use-backdate-confirm';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { useSession } from '@/lib/session';
import { LINK_CLASSNAME } from '@/lib/utils';
import { OrderPriorityControl } from '@/components/production-queue';
import { BackdateConfirmDialog } from '@/components/backdate-confirm-dialog';
import { InfoPopover } from '@/components/info-popover';
import { OperationDateField } from '@/components/operation-date-field';
import { LengthEditor } from '@/components/production/length-editor';
import { ReasonDialog } from '@/components/reason-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CoilPicker } from './coil-picker';

/**
 * El ciclo completo de **una** orden de coberturas dentro del espacio de producción
 * (D-155, rehecho por D-159 y por D-191).
 *
 * - **El plan de corte se edita acá** (D-159). En una plancha de catálogo, solo la cantidad.
 * - **D-191: lo que salió se carga en un borrador y se ejecuta todo junto.** Cada fila del
 *   borrador es un reporte (bobina, largos, kg declarado) que vive en el servidor —sobrevive
 *   un refresh o un corte de luz— y se edita o se quita mientras no se ejecute. Ni el kardex
 *   ni la reserva se mueven hasta «Ejecutar», que valida todo otra vez y graba todas las filas
 *   en una sola transacción: si una falla, no entra ninguna y el error nombra la fila.
 * - **Ejecutar y cerrar** es una sola transacción, como era «Guardar y cerrar»: libera la
 *   bobina para la orden hermana en el acto.
 *
 * Lo que **no** cambió: el tope de metros del plan sigue siendo duro (D-146) —y ahora cuenta lo
 * que el borrador ya ocupa— y las desviaciones del kilo declarado y el faltante del agregado
 * siguen siendo avisos (D-154).
 */

/** Lo que se está escribiendo en una orden. Vive **en el padre**, indexado por orden. */
export interface OrderDraft {
  /**
   * Filas del editor. `null` es "todavía no se sembró": el panel lo rellena con el plan
   * faltante (si el borrador está vacío) y a partir de ahí es del usuario. Distinguir `null` de
   * `[]` es lo que evita que borrar todas las líneas las haga reaparecer.
   */
  rows: PieceRow[] | null;
  /** D-146: kilos declarados para **esta** fila. Dato de planta, no consumo. */
  consumedKg: string;
  /** D-089: kilos que la bobina consumió en **toda** la corrida; de acá sale el despunte. */
  closeKg: string;
  coilId: string;
  /** Filas del plan de corte mientras se edita. `null` = no se está editando. */
  planRows: PieceRow[] | null;
  /** D-191: la fila del borrador que el editor está corrigiendo. `null` = se agrega una nueva. */
  editingDraftId: string | null;
}

export const EMPTY_DRAFT: OrderDraft = {
  rows: null,
  consumedKg: '',
  closeKg: '',
  coilId: '',
  planRows: null,
  editingDraftId: null,
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
 * F8-S3c/M3: metro lineal equivalente de lo que le queda a una bobina montada (D-116, la
 * misma cuenta que ya da `CoilDto.equivalentMeters` para el saldo entero). Presentación
 * pura: la asignación real sigue en kg, esto solo la traduce para quien piensa en metros.
 * `null` con geometría en cero (no debería pasar con datos reales).
 */
function equivalentMetersOf(coil: RoofingBatchCoilDto): string | null {
  const perMeter = kgPerMeter(coil);
  if (perMeter.lte(0)) return null;
  return toFixedString(toDecimal(coil.remainingKg).div(perMeter), 'KG');
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
  /**
   * La lista de órdenes se está refrescando. Bloquea los envíos: tras ejecutar, el `order` de
   * esta pestaña sigue siendo el viejo hasta que llega el refetch, y el botón quedaría
   * habilitado sobre un borrador que ya no existe.
   */
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
  /** Motivo del despunte cuando el cierre lo exige (D-089). */
  const [askingReason, setAskingReason] = useState(false);
  /** Qué botón disparó la ejecución: decide si también cierra. Solo para el rótulo. */
  const [pendingClose, setPendingClose] = useState(false);
  /**
   * **Los dos datos que deciden el envío van por `ref` y no por estado**: el botón los fija y
   * dispara el envío en el mismo manejador, y un `setState` no se ve hasta el render siguiente.
   */
  const closeMode = useRef(false);
  const reasonToSend = useRef<string | null>(null);
  const lastCloseMode = useRef<boolean | null>(null);
  /** Cuál de los dos cierres está esperando el motivo: el diálogo es uno solo. */
  const reasonFor = useRef<'commit' | 'close-only'>('commit');

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
      reopen?: { coilIds: string[]; reason: string };
    }) =>
      api<ProductionOrderDto>(`/production/roofing/${order.orderId}/coils`, {
        method: 'POST',
        body: {
          ...(coilIds.length === 1 ? { coilId: coilIds[0] } : { coilIds }),
          ...(reopen ? { reopenCoilIds: reopen.coilIds, reopenReason: reopen.reason } : {}),
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
      // D-159: el editor llega relleno con lo que el plan todavía debe.
      onDraft({ rows: null, consumedKg: '', editingDraftId: null });
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo montar la bobina'),
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
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo bajar la bobina'),
  });

  const savePlan = useMutation({
    mutationFn: (pieces: RoofingPieceDto[]) =>
      api<ProductionOrderDto>(`/production/roofing/${order.orderId}/plan`, {
        method: 'PUT',
        body: { items: pieces.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty })) },
      }),
    onSuccess: () => {
      toast.success('Plan de corte actualizado');
      onDraft({ planRows: null, rows: null, consumedKg: '', editingDraftId: null });
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar el plan'),
  });

  const resolved = resolveDraft(order, draft);
  const editing = order.drafts.find((d) => d.id === draft.editingDraftId) ?? null;
  const staleEditing = draft.editingDraftId !== null && editing === null && !refreshing;
  useEffect(() => {
    if (!staleEditing) return;
    toast.warning('La fila que corregías ya no está en el borrador: se descartó la corrección.');
    onDraft({ rows: null, consumedKg: '', editingDraftId: null });
  }, [staleEditing, onDraft]);

  // -------------------------------------------------------------------------
  // D-191 — el borrador
  // -------------------------------------------------------------------------

  const saveDraft = useMutation({
    mutationFn: (pieces: RoofingPieceDto[]) =>
      api<RoofingReportDraftDto[]>(
        editing === null
          ? `/production/roofing/${order.orderId}/drafts`
          : `/production/roofing/${order.orderId}/drafts/${editing.id}`,
        {
          method: editing === null ? 'POST' : 'PUT',
          body: {
            pieces: pieces.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty })),
            ...(resolved.coil ? { coilId: resolved.coil.coilId } : {}),
            ...(draft.consumedKg.trim()
              ? { consumedKg: toDecimal(draft.consumedKg.trim()).toFixed(3) }
              : {}),
          },
        },
      ),
    onSuccess: () => {
      toast.success(
        editing === null
          ? `${order.code}: fila agregada al borrador`
          : `${order.code}: fila ${String(editing.rowNumber)} corregida`,
      );
      // Tras agregar, el editor queda vacío: lo que falta del plan ya lo ocupa el borrador.
      onDraft({ rows: [EMPTY_PIECE_ROW], consumedKg: '', editingDraftId: null });
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar la fila'),
  });

  const removeDraft = useMutation({
    mutationFn: (draftId: string) =>
      api<RoofingReportDraftDto[]>(`/production/roofing/${order.orderId}/drafts/${draftId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_data, draftId) => {
      toast.success(`${order.code}: fila quitada del borrador`);
      if (draft.editingDraftId === draftId) {
        onDraft({ rows: null, consumedKg: '', editingDraftId: null });
      }
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo quitar la fila'),
  });

  const submitKey = useIdempotencyKey();
  const commit = useMutation({
    mutationFn: ({
      close,
      reason,
      confirmBackdate,
    }: {
      close: boolean;
      reason: string | null;
      confirmBackdate: boolean;
    }) =>
      api<ProductionOrderDto>(`/production/roofing/${order.orderId}/drafts/commit`, {
        method: 'POST',
        body: {
          ...(close ? { close: true } : {}),
          ...(close && reason ? { closeReason: reason } : {}),
          // D-089: el consumo real de toda la corrida, que es de donde sale el despunte.
          ...(close && draft.closeKg.trim()
            ? { closeConsumedKg: toDecimal(draft.closeKg.trim()).toFixed(3) }
            : {}),
          operationDate,
          confirmBackdate: confirmBackdate || undefined,
          idempotencyKey: submitKey.current(),
        },
      }),
    onSettled: (_data, error) => {
      submitKey.settle(error ?? undefined);
    },
    onSuccess: (updated, variables) => {
      toast.success(
        variables.close
          ? `${order.code}: borrador ejecutado y orden cerrada`
          : `${order.code}: borrador ejecutado`,
      );
      onNotes({ pool: updated.rawMaterialWarnings ?? [], note: resolved.draftDeviation });
      onDraft({ rows: null, consumedKg: '', closeKg: '', editingDraftId: null });
      reasonToSend.current = null;
      invalidate();
    },
    onError: (err) => {
      // D-089: el cierre pide motivo cuando el despunte pasa del umbral, y lo decide el API.
      if (err instanceof ApiError && /motivo/i.test(err.message) && closeMode.current) {
        setAskingReason(true);
        return;
      }
      reasonToSend.current = null;
      toast.error(err instanceof ApiError ? err.message : 'No se pudo ejecutar el borrador');
    },
  });

  /** El cierre suelto: sin borrador pendiente, no queda nada que reportar. */
  const closeOnly = useMutation({
    mutationFn: (reason: string | null) =>
      api<ProductionOrderDto>(`/production/roofing/${order.orderId}/close`, {
        method: 'POST',
        body: {
          ...(reason ? { reason } : {}),
          ...(draft.closeKg.trim()
            ? { consumedKg: toDecimal(draft.closeKg.trim()).toFixed(3) }
            : {}),
          operationDate,
        },
      }),
    onSuccess: (updated) => {
      toast.success(
        `${order.code}: orden cerrada con ${formatQty(updated.scrapKg ?? '0.000', 'kg')} de despunte`,
      );
      reasonToSend.current = null;
      invalidate();
    },
    onError: (err) => {
      if (err instanceof ApiError && /motivo/i.test(err.message)) {
        setAskingReason(true);
        return;
      }
      toast.error(err instanceof ApiError ? err.message : 'No se pudo cerrar la orden');
    },
  });

  /** Ejecutar, con o sin cierre, envuelto en el diálogo de retro-fecha (D-124). */
  const submit = useBackdateConfirm(async (confirmBackdate) => {
    await commit.mutateAsync({
      close: closeMode.current,
      reason: reasonToSend.current,
      confirmBackdate,
    });
  });

  const start = (close: boolean) => {
    if (lastCloseMode.current !== null && lastCloseMode.current !== close) submitKey.settle();
    lastCloseMode.current = close;
    closeMode.current = close;
    reasonFor.current = 'commit';
    setPendingClose(close);
    // El motivo se pide **antes** de mandar cuando la pantalla ya sabe que el API lo va a
    // exigir: gastar un 400 para descubrirlo es la peor forma de enterarse.
    if (close && resolved.needsCloseReason && reasonToSend.current === null) {
      setAskingReason(true);
      return;
    }
    void submit.attempt();
  };

  const liveCoils = order.coils;
  const state = stateOf(order);
  const full = liveCoils.length >= MAX_ORDER_STRIPS;
  const planCovered = order.planItems.length > 0 && toDecimal(order.remainingMeters).lte(0);
  const hasDrafts = order.drafts.length > 0;
  /**
   * **Cerrar sin reportar más existe siempre que la orden ya haya producido algo** y el borrador
   * esté vacío: el caso más común es la bobina que se acabó antes del plan. Con filas en el
   * borrador el cierre va por «Ejecutar y cerrar», que las graba primero.
   */
  const canCloseOnly = toDecimal(order.reportedKg).gt(0) && !hasDrafts;
  const canCloseWithCommit = hasDrafts;
  const busy =
    commit.isPending ||
    closeOnly.isPending ||
    saveDraft.isPending ||
    removeDraft.isPending ||
    savePlan.isPending ||
    mount.isPending ||
    release.isPending ||
    refreshing;
  /**
   * ALTO de la revisión: una fila escrita en el editor y **no agregada** no se ejecuta. Si los
   * botones de ejecutar siguieran habilitados, «Ejecutar y cerrar» grababa el borrador sin ella,
   * cerraba la orden y el éxito limpiaba el editor: lo que salió de la roladora quedaba sin
   * reportar en una orden cerrada.
   */
  const unsavedEditor = resolved.pieces !== null || resolved.error !== null;

  return (
    // Con la forma de lista, `tabpanel` sería un huérfano: no hay ningún `tablist` que lo
    // contenga y `aria-labelledby` apuntaría a un botón que ya no se anuncia como pestaña.
    <section
      role={asList ? undefined : 'tabpanel'}
      id={`panel-${order.orderId}`}
      aria-labelledby={`tab-${order.orderId}`}
      className="grid gap-4"
    >
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <span className="font-mono">{order.code}</span>
            <StateBadge state={state} />
            <span className="font-normal text-muted-foreground">
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
            </span>
            {order.priority && <Badge>Prioridad</Badge>}
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
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
            <MiniStat label="ML del plan" value={`${order.planMeters} m`} />
            <MiniStat label="ML reportado" value={`${order.reportedMeters} m`} />
            <MiniStat
              label="ML restante"
              value={`${order.remainingMeters} m`}
              tone={planCovered ? 'alert' : 'strong'}
              hint={hasDrafts ? `${order.draftMeters} m en el borrador` : undefined}
            />
            <MiniStat
              label="kg teórico del plan"
              value={resolved.planKg === null ? '—' : `${resolved.planKg.toFixed(3)} kg`}
              hint={
                liveCoils.length === 0
                  ? 'Monta una bobina'
                  : resolved.coil === undefined
                    ? 'Elige la bobina'
                    : undefined
              }
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {order.remainingPieces.length > 0
              ? `Faltan ${describePieces(order.remainingPieces)}`
              : 'El plan ya está cubierto.'}
            {' · '}
            <Link href={`/produccion/${order.orderId}`} className="underline">
              Ver el detalle de la orden
            </Link>
          </p>
        </CardContent>
      </Card>

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

      <PlanCard
        order={order}
        rows={draft.planRows}
        pending={savePlan.isPending}
        onRows={(planRows) => {
          onDraft({ planRows });
        }}
        onSave={(pieces) => {
          savePlan.mutate(pieces);
        }}
      />

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
                    {c.widthMm} mm · pendiente {formatQty(c.remainingKg, 'kg')}
                    {/*
                      F8-S3c/M3: kg · ≈ ML de lo que le queda a esta bobina montada (D-116),
                      presentación pura — la asignación y el kardex siguen en kg.
                    */}
                    {remainingMeters !== null && <> · ≈ {formatQty(remainingMeters, 'm')}</>}
                  </div>
                </div>
                {/* S10/M3: avance de la orden mientras esta bobina está montada, solo lectura. */}
                <div className="text-sm text-muted-foreground">
                  {formatQty(order.reportedMeters, 'm')} de la orden ·{' '}
                  {formatQty(c.consumedKg, 'kg')} consumidos de esta bobina
                </div>
                <div className="flex items-center gap-2">
                  {liveCoils.length > 1 && (
                    <Button
                      variant={resolved.coil?.coilId === c.coilId ? 'default' : 'outline'}
                      className="h-11"
                      aria-label={`Reportar desde la bobina ${c.coilCode}`}
                      onClick={() => {
                        onDraft({ coilId: c.coilId });
                      }}
                    >
                      {resolved.coil?.coilId === c.coilId ? 'Elegida' : 'Usar esta'}
                    </Button>
                  )}
                  {/* Una bobina que ya roló no se baja: hay que revertir esos reportes primero
                      (RF-33). Tampoco con filas del borrador que salen de ella (D-191). */}
                  <Button
                    variant="outline"
                    className="h-11"
                    aria-label={`Bajar la bobina ${c.coilCode} de ${order.code}`}
                    disabled={
                      release.isPending ||
                      toDecimal(c.consumedKg).gt(0) ||
                      order.drafts.some((d) => d.coilId === c.coilId)
                    }
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

          {full ? (
            <p className="text-sm text-destructive">
              La orden ya tiene las {MAX_ORDER_STRIPS} bobinas que admite a la vez: ciérrala o baja
              alguna antes de montar otra.
            </p>
          ) : (
            <CoilPicker
              orderCode={order.code}
              productSku={order.productSku}
              options={options.data ?? []}
              loading={options.isPending}
              failed={options.isError}
              mountedCount={liveCoils.length}
              pending={mount.isPending}
              onMount={(coilIds, reopen) => {
                mount.mutate({ coilIds, ...(reopen ? { reopen } : {}) });
              }}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            Reportar lo que salió
            <InfoPopover label="Sobre el borrador de reportes">
              Cada fila del borrador es un reporte. Queda guardado aunque cierres la pantalla, y no
              mueve inventario hasta que lo ejecutes: ahí se graban todas las filas juntas, o
              ninguna si alguna falla.
            </InfoPopover>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {liveCoils.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Monta una bobina y las líneas del plan que falta aparecen acá, listas para ajustar.
            </p>
          ) : (
            <div className="grid gap-3 rounded-lg border p-3">
              {editing !== null && (
                <p className="text-sm font-medium">Corrigiendo la fila {editing.rowNumber}</p>
              )}
              <LengthEditor
                rows={draft.rows ?? seedRows(order)}
                idPrefix={`reporte-${order.orderId}`}
                disabled={busy}
                onChange={(rows) => {
                  onDraft({ rows });
                }}
              />

              <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-end">
                <div className="grid gap-1.5">
                  <Label htmlFor={`kg-${order.orderId}`} className="flex items-center gap-1.5">
                    kg consumido (opcional)
                    <InfoPopover label="Sobre el kg consumido">
                      Dato de planta: el kardex sale por el kilo teórico y el consumo real se
                      reconcilia al cerrar.
                    </InfoPopover>
                  </Label>
                  <Input
                    id={`kg-${order.orderId}`}
                    aria-label={`Kilos consumidos de ${order.code}`}
                    inputMode="decimal"
                    placeholder={resolved.newKg === null ? 'opcional' : resolved.newKg.toFixed(3)}
                    disabled={busy}
                    value={draft.consumedKg}
                    onChange={(e) => {
                      onDraft({ consumedKg: e.target.value });
                    }}
                  />
                </div>
                <div className="grid gap-1 text-sm">
                  {resolved.pieces && (
                    <p className="text-muted-foreground">
                      {describePieces(resolved.pieces)} · {resolved.meters.toFixed(3)} m
                      {resolved.newKg !== null && <> · {resolved.newKg.toFixed(3)} kg teóricos</>}
                    </p>
                  )}
                  {resolved.error !== null && <p className="text-destructive">{resolved.error}</p>}
                  {resolved.deviation !== null && (
                    <p className="text-amber-700 dark:text-amber-500">⚠ {resolved.deviation}</p>
                  )}
                  {resolved.completesPlan && (
                    <p className="text-muted-foreground">
                      Con esta fila el borrador cubre el plan: agrégala y después «Ejecutar y
                      cerrar» lo graba, cierra la orden y libera la bobina para la orden siguiente.
                    </p>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                {editing !== null && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      onDraft({ rows: null, consumedKg: '', editingDraftId: null });
                    }}
                  >
                    Cancelar corrección
                  </Button>
                )}
                <Button
                  variant={hasDrafts && editing === null ? 'outline' : 'default'}
                  aria-label={
                    editing === null
                      ? `Agregar al borrador de ${order.code}`
                      : `Guardar la fila ${String(editing.rowNumber)} de ${order.code}`
                  }
                  disabled={resolved.pieces === null || resolved.error !== null || busy}
                  onClick={() => {
                    if (resolved.pieces) saveDraft.mutate(resolved.pieces);
                  }}
                >
                  {saveDraft.isPending
                    ? 'Guardando…'
                    : editing === null
                      ? 'Agregar al borrador'
                      : `Guardar fila ${String(editing.rowNumber)}`}
                </Button>
              </div>
            </div>
          )}

          {hasDrafts && (
            <div className="grid gap-2">
              <p className="text-sm font-medium">
                Borrador de {order.code}: {order.drafts.length}{' '}
                {order.drafts.length === 1 ? 'fila' : 'filas'} · {order.draftMeters} m sin ejecutar
              </p>
              <div className="overflow-x-auto rounded-lg border">
                <Table aria-label={`Borrador de ${order.code}`}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fila</TableHead>
                      <TableHead>Bobina</TableHead>
                      <TableHead>Largos</TableHead>
                      <TableHead className="text-right">m</TableHead>
                      <TableHead className="text-right">kg teóricos</TableHead>
                      <TableHead className="text-right">kg declarados</TableHead>
                      <TableHead className="text-right">Acciones</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {order.drafts.map((d) => (
                      <TableRow
                        key={d.id}
                        className={d.id === draft.editingDraftId ? 'bg-primary/5' : undefined}
                      >
                        <TableCell>{d.rowNumber}</TableCell>
                        <TableCell className="font-mono">{d.coilCode}</TableCell>
                        <TableCell>{describePieces(d.pieces)}</TableCell>
                        <TableCell className="text-right tabular-nums">{d.meters}</TableCell>
                        <TableCell className="text-right tabular-nums">{d.theoreticalKg}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {d.consumedKg ?? '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Corregir la fila ${String(d.rowNumber)} de ${order.code}`}
                            disabled={busy}
                            onClick={() => {
                              onDraft({
                                editingDraftId: d.id,
                                coilId: d.coilId,
                                consumedKg: d.consumedKg ?? '',
                                rows: d.pieces.map((p) => ({
                                  lengthM: mmToMeters(p.lengthMm),
                                  qty: String(p.qty),
                                })),
                              });
                            }}
                          >
                            Corregir
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Quitar la fila ${String(d.rowNumber)} de ${order.code}`}
                            disabled={busy}
                            onClick={() => {
                              removeDraft.mutate(d.id);
                            }}
                          >
                            Quitar
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {/*
            D-089: los kilos que la bobina consumió **de verdad** en toda la corrida. Es el dato
            del que sale el despunte, y sin él el cierre asume merma cero.
          */}
          {(canCloseOnly || canCloseWithCommit) && (
            <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-start">
              <div className="grid gap-1.5">
                <Label htmlFor={`cierre-kg-${order.orderId}`}>
                  kg que consumió la bobina (opcional)
                </Label>
                <Input
                  id={`cierre-kg-${order.orderId}`}
                  aria-label={`Kilos consumidos al cerrar ${order.code}`}
                  inputMode="decimal"
                  placeholder={resolved.closeBounds.consumedFloorKg.toFixed(3)}
                  disabled={busy}
                  value={draft.closeKg}
                  onChange={(e) => {
                    reasonToSend.current = null;
                    onDraft({ closeKg: e.target.value });
                  }}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Sin este dato el cierre usa los kilos declarados reporte a reporte (y el teórico
                donde no se declaró); el piso son los{' '}
                {formatQty(resolved.closeBounds.consumedFloorKg.toFixed(3), 'kg')} teóricos de las
                planchas {hasDrafts ? 'reportadas y del borrador' : 'ya reportadas'}. Lo que pase
                del piso sale como despunte; el resto de la bobina vuelve al almacén.
                {draft.closeKg.trim() === '' && resolved.estimatedScrapKg.gt(0) && (
                  <> Despunte estimado: {formatQty(resolved.estimatedScrapKg.toFixed(3), 'kg')}.</>
                )}
                {resolved.closeBounds.closeKgError !== null && (
                  <span className="text-destructive"> {resolved.closeBounds.closeKgError}</span>
                )}
                {resolved.closeBounds.scrapKg.gt(0) &&
                  resolved.closeBounds.closeKgError === null && (
                    <>
                      {' '}
                      Despunte al cerrar: {formatQty(resolved.closeBounds.scrapKg.toFixed(3), 'kg')}
                      .
                    </>
                  )}
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <OperationDateField value={operationDate} onChange={onOperationDate} />
            {hasDrafts && (
              <>
                <Button
                  variant={resolved.draftCoversPlan ? 'outline' : 'default'}
                  aria-label={`Ejecutar el borrador de ${order.code}`}
                  disabled={busy || editing !== null || unsavedEditor}
                  onClick={() => {
                    start(false);
                  }}
                >
                  {commit.isPending && !pendingClose ? 'Ejecutando…' : 'Ejecutar borrador'}
                </Button>
                <Button
                  variant={resolved.draftCoversPlan ? 'default' : 'outline'}
                  aria-label={`Ejecutar el borrador y cerrar ${order.code}`}
                  disabled={
                    busy ||
                    editing !== null ||
                    unsavedEditor ||
                    resolved.closeBounds.closeKgError !== null
                  }
                  onClick={() => {
                    start(true);
                  }}
                >
                  {commit.isPending && pendingClose ? 'Cerrando…' : 'Ejecutar y cerrar'}
                </Button>
              </>
            )}
            {canCloseOnly && (
              <Button
                variant="outline"
                aria-label={`Cerrar ${order.code} sin reportar más`}
                disabled={busy || resolved.closeBounds.closeKgError !== null}
                onClick={() => {
                  reasonFor.current = 'close-only';
                  closeOnly.mutate(reasonToSend.current);
                }}
              >
                {closeOnly.isPending
                  ? 'Cerrando…'
                  : `Cerrar ${order.code} sin reportar más${planCovered ? '' : ' (la bobina se acabó)'}`}
              </Button>
            )}
          </div>
          {hasDrafts && editing !== null && (
            <p className="text-right text-xs text-muted-foreground">
              Termina o cancela la corrección antes de ejecutar.
            </p>
          )}
          {hasDrafts && editing === null && unsavedEditor && (
            <p className="text-right text-xs text-muted-foreground">
              Hay una fila escrita en el editor: agrégala al borrador o vacía el editor antes de
              ejecutar.
            </p>
          )}
        </CardContent>
      </Card>

      <ReasonDialog
        open={askingReason}
        onOpenChange={(open) => {
          if (!open) reasonToSend.current = null;
          setAskingReason(open);
        }}
        title="Cerrar con despunte alto"
        description={`Las planchas representan ${formatQty(
          resolved.closeBounds.consumedFloorKg.toFixed(3),
          'kg',
        )} y se declara un consumo mayor: la diferencia —más del ${String(MAX_SCRAP_RATIO_WITHOUT_REASON * 100)} %— sale del inventario como despunte y su costo se reparte entre el producto bueno. Explica por qué.`}
        confirmLabel="Cerrar la orden"
        pending={busy}
        onConfirm={(reason: string) => {
          reasonToSend.current = reason;
          setAskingReason(false);
          if (reasonFor.current === 'close-only') closeOnly.mutate(reason);
          else start(true);
        }}
      />

      <BackdateConfirmDialog
        open={submit.open}
        onOpenChange={(open) => {
          if (!open) {
            reasonToSend.current = null;
            submit.close();
          }
        }}
        detail={submit.detail ?? ''}
        pending={commit.isPending}
        onConfirm={() => {
          void submit.confirm();
        }}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// El plan de corte, editable desde acá (D-159)
// ---------------------------------------------------------------------------

function PlanCard({
  order,
  rows,
  pending,
  onRows,
  onSave,
}: {
  order: RoofingBatchOrderDto;
  rows: PieceRow[] | null;
  pending: boolean;
  onRows: (rows: PieceRow[] | null) => void;
  onSave: (pieces: RoofingPieceDto[]) => void;
}) {
  /**
   * D-118/D-159: en una plancha de catálogo el largo **no se elige**, lo trae el SKU. El
   * supervisor solo dice cuántas, y el editor de largos completo sería un campo de más cuya
   * única respuesta correcta ya está en la base.
   */
  const fixedLengthMm = order.productUnit === Unit.MTR ? null : order.productLengthMm;
  const editing = rows !== null;
  const parsed = rows === null ? null : parsePieceRows(rows);

  const startEditing = () => {
    if (fixedLengthMm !== null) {
      onRows([
        {
          lengthM: mmToMeters(fixedLengthMm),
          qty: String(order.planItems.reduce((acc, p) => acc + p.qty, 0) || ''),
        },
      ]);
      return;
    }
    onRows(
      order.planItems.length === 0
        ? [EMPTY_PIECE_ROW]
        : order.planItems.map((p) => ({ lengthM: mmToMeters(p.lengthMm), qty: String(p.qty) })),
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          Plan de corte
          <InfoPopover label="Sobre el plan de corte">
            El plan es una intención: lo que mueve inventario son los largos que reportes. Es
            también el tope de lo que se puede reportar (D-146), así que si de verdad hay que
            producir más, se cambia acá.
          </InfoPopover>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {order.planItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            La orden no tiene plan de corte: escríbelo antes de reportar.
          </p>
        ) : (
          <p className="text-lg">
            {describePieces(order.planItems)}{' '}
            <span className="text-sm text-muted-foreground">({order.planMeters} m)</span>
          </p>
        )}

        {!editing && (
          <Button
            variant="outline"
            className="justify-self-start"
            aria-label={`Ajustar el plan de corte de ${order.code}`}
            onClick={startEditing}
          >
            Ajustar el plan
          </Button>
        )}

        {editing && rows !== null && (
          <div className="grid gap-3 rounded-lg border p-3">
            {fixedLengthMm === null ? (
              <LengthEditor
                rows={rows}
                idPrefix={`plan-${order.orderId}`}
                disabled={pending}
                onChange={onRows}
              />
            ) : (
              <div className="grid max-w-xs gap-1.5">
                <Label htmlFor={`plan-planchas-${order.orderId}`}>
                  Planchas de {mmToMeters(fixedLengthMm)} m
                </Label>
                <Input
                  id={`plan-planchas-${order.orderId}`}
                  aria-label={`Planchas del plan de ${order.code}`}
                  inputMode="numeric"
                  disabled={pending}
                  value={rows[0]?.qty ?? ''}
                  onChange={(e) => {
                    onRows([{ lengthM: mmToMeters(fixedLengthMm), qty: e.target.value }]);
                  }}
                />
              </div>
            )}
            {parsed !== null && !parsed.ok && (
              <p className="text-sm text-destructive">{parsed.reason}</p>
            )}
            <div className="flex gap-2">
              <Button
                disabled={parsed === null || !parsed.ok || pending}
                onClick={() => {
                  if (parsed?.ok) onSave(parsed.pieces);
                }}
              >
                {pending ? 'Guardando…' : 'Guardar plan'}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  onRows(null);
                }}
              >
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
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
  return (
    <Badge
      variant={
        state === 'reportada'
          ? 'secondary'
          : state === 'lista'
            ? 'default'
            : state === 'sin-plan'
              ? 'destructive'
              : 'outline'
      }
    >
      {STATE_LABELS[state]}
    </Badge>
  );
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

// ---------------------------------------------------------------------------
// Lo que el borrador de una pestaña resuelve, con las funciones del API
// ---------------------------------------------------------------------------

/**
 * El plan que todavía falta, como filas del editor. Con filas en el borrador el editor arranca
 * vacío: lo que falta del plan ya lo ocupan esas filas, y sembrarlo otra vez invitaba a
 * cargarlo dos veces.
 */
function seedRows(order: RoofingBatchOrderDto): PieceRow[] {
  if (order.drafts.length > 0 || order.remainingPieces.length === 0) return [EMPTY_PIECE_ROW];
  return order.remainingPieces.map((p) => ({
    lengthM: mmToMeters(p.lengthMm),
    qty: String(p.qty),
  }));
}

interface ResolvedDraft {
  coil: RoofingBatchOrderDto['coils'][number] | undefined;
  planKg: Decimal | null;
  pieces: RoofingPieceDto[] | null;
  meters: Decimal;
  newKg: Decimal | null;
  /** La fila que se escribe deja el borrador cubriendo exactamente el plan. */
  completesPlan: boolean;
  /** El borrador guardado ya cubre el plan: «Ejecutar y cerrar» pasa a ser la acción primaria. */
  draftCoversPlan: boolean;
  /** El API va a exigir motivo para el despunte de este cierre (D-089). */
  needsCloseReason: boolean;
  /** Despunte que el cierre sacaría con el campo vacío, estimado como lo estima el motivo. */
  estimatedScrapKg: Decimal;
  /**
   * D-089: las cotas del kg declarado al cerrar. Con borrador, el piso incluye sus filas
   * («Ejecutar y cerrar» las graba antes de cerrar); sin borrador es el cierre suelto.
   */
  closeBounds: CloseBounds;
  /** Lo que el API también rechaza: el botón se apaga. */
  error: string | null;
  /** Lo que el API **acepta** y anota igual (D-154): se muestra y no bloquea. */
  deviation: string | null;
  /** La desviación que el borrador guardado va a dejar anotada, para retenerla tras ejecutar. */
  draftDeviation: string | null;
}

interface CloseBounds {
  /** Lo que las planchas —reportadas y del borrador— representan: despunte cero. */
  consumedFloorKg: Decimal;
  /** Por qué el kg declarado no sirve. `null` cuando está vacío o dentro de las cotas. */
  closeKgError: string | null;
  /** Lo declarado menos el piso: lo que va a salir del inventario como despunte. */
  scrapKg: Decimal;
}

function closeBoundsOf(
  order: RoofingBatchOrderDto,
  closeKg: string,
  extraReportedKg: Decimal,
): CloseBounds {
  const floor = toDecimal(order.reportedKg).plus(extraReportedKg);
  const mounted = order.coils.reduce(
    (acc, c) => acc.plus(toDecimal(c.remainingKg)),
    toDecimal(order.reportedKg),
  );
  const none = { consumedFloorKg: floor, closeKgError: null, scrapKg: new Decimal(0) };
  const raw = closeKg.trim();
  if (raw === '') return none;
  if (!/^\d+(\.\d{1,3})?$/.test(raw) || toDecimal(raw).lte(0)) {
    return { ...none, closeKgError: 'Los kilos van con hasta tres decimales y mayores a cero.' };
  }
  const declared = toDecimal(raw);
  if (declared.lt(floor)) {
    return {
      ...none,
      closeKgError: `Las planchas ya consumieron ${floor.toFixed(3)} kg: no se puede declarar menos.`,
    };
  }
  if (declared.gt(mounted)) {
    return {
      ...none,
      closeKgError: `La orden tiene ${mounted.toFixed(3)} kg montados: monta más material o corrige la cifra.`,
    };
  }
  return { consumedFloorKg: floor, closeKgError: null, scrapKg: declared.minus(floor) };
}

function resolveDraft(order: RoofingBatchOrderDto, draft: OrderDraft): ResolvedDraft {
  const coil =
    order.coils.length === 1 ? order.coils[0] : order.coils.find((c) => c.coilId === draft.coilId);
  const geometry =
    coil === undefined
      ? null
      : { widthMm: coil.widthMm, thicknessMm: coil.thicknessMm, densityFactor: coil.densityFactor };
  const planKg =
    geometry === null || order.planItems.length === 0
      ? null
      : piecesTheoreticalKg(geometry, order.planItems);

  // Las filas del borrador que **no** son la que se corrige: esas ya ocupan plan y bobina.
  const others = order.drafts.filter((d) => d.id !== draft.editingDraftId);
  const othersMeters = others.reduce((acc, d) => acc.plus(toDecimal(d.meters)), new Decimal(0));
  const draftKg = order.drafts.reduce(
    (acc, d) => acc.plus(toDecimal(d.theoreticalKg)),
    new Decimal(0),
  );
  const draftDeclaredKg = order.drafts.reduce(
    (acc, d) => acc.plus(d.consumedKg === null ? new Decimal(0) : toDecimal(d.consumedKg)),
    new Decimal(0),
  );
  const available = Decimal.max(
    toDecimal(order.remainingMeters).minus(othersMeters),
    new Decimal(0),
  );
  const closeBounds = closeBoundsOf(order, draft.closeKg, draftKg);

  // D-089: lo declarado menos lo que las planchas representan es el despunte, y por encima del
  // umbral el API pide motivo. La pantalla lo **estima**; el 400 conserva su camino de vuelta.
  const floor = closeBounds.consumedFloorKg;
  const declared = draft.closeKg.trim()
    ? floor.plus(closeBounds.scrapKg)
    : Decimal.max(toDecimal(order.declaredKg).plus(draftDeclaredKg), floor);
  const needsCloseReason =
    declared.gt(0) &&
    declared
      .minus(floor)
      .div(declared)
      .gt(toDecimal(String(MAX_SCRAP_RATIO_WITHOUT_REASON)));

  const draftDeviation =
    planKg === null || draftDeclaredKg.isZero()
      ? null
      : roofingConsumptionDeviation({
          declaredKg: draftDeclaredKg,
          theoreticalKg: draftKg,
          alreadyDeclaredKg: order.declaredKg,
          planKg,
        });

  const base: ResolvedDraft = {
    coil,
    planKg,
    pieces: null,
    meters: new Decimal(0),
    newKg: null,
    completesPlan: false,
    draftCoversPlan:
      order.planItems.length > 0 &&
      order.drafts.length > 0 &&
      toDecimal(order.draftMeters).equals(toDecimal(order.remainingMeters)),
    needsCloseReason,
    estimatedScrapKg: declared.minus(floor),
    closeBounds,
    error: null,
    deviation: null,
    draftDeviation,
  };

  if (order.coils.length === 0) return base;
  const rows = draft.rows ?? seedRows(order);
  // Editor vacío: no hay nada que agregar, y no es un error que haya que pintar en rojo.
  if (rows.every((r) => r.lengthM.trim() === '' && r.qty.trim() === '')) return base;
  const parsed = parsePieceRows(rows);
  if (!parsed.ok) return { ...base, error: parsed.reason };
  if (order.coils.length > 1 && coil === undefined) {
    return { ...base, error: 'Indica de qué bobina salieron.' };
  }

  const pieces = parsed.pieces;
  if (order.productUnit !== Unit.MTR && order.productLengthMm !== null) {
    const fixed = toDecimal(order.productLengthMm);
    const off = pieces.find((p) => !toDecimal(p.lengthMm).equals(fixed));
    if (off) {
      return {
        ...base,
        error: `${order.productSku} es una plancha de catálogo de ${mmToMeters(order.productLengthMm)} m: no admite un largo de ${mmToMeters(off.lengthMm)} m.`,
      };
    }
  }
  const meters = piecesMeters(pieces);
  const newKg = geometry === null ? null : piecesTheoreticalKg(geometry, pieces);
  const completesPlan = order.planItems.length > 0 && meters.equals(available);

  // D-146 con el borrador adentro: lo que ya ocupan las otras filas cuenta como reportado.
  if (order.planItems.length > 0 && meters.gt(available)) {
    return {
      ...base,
      pieces,
      meters,
      newKg,
      error:
        `Del plan quedan ${available.toFixed(3)} m` +
        (othersMeters.gt(0) ? ` descontando el borrador` : '') +
        ` y esto suma ${meters.toFixed(3)} m: ajusta el plan de corte si de verdad hay que producir más.`,
    };
  }

  // Los kilos de la bobina que ya toman las otras filas del borrador, también.
  if (coil !== undefined && newKg !== null) {
    const taken = others
      .filter((d) => d.coilId === coil.coilId)
      .reduce((acc, d) => acc.plus(toDecimal(d.theoreticalKg)), new Decimal(0));
    const left = toDecimal(coil.remainingKg).minus(taken);
    if (newKg.gt(left)) {
      return {
        ...base,
        pieces,
        meters,
        newKg,
        completesPlan,
        error:
          `${coil.coilCode} tiene ${left.toFixed(3)} kg montados` +
          (taken.gt(0) ? ' libres del borrador' : '') +
          ` y esto necesita ${newKg.toFixed(3)} kg: monta más material.`,
      };
    }
  }

  const kg = draft.consumedKg.trim();
  if (kg !== '' && (!/^\d+(\.\d{1,3})?$/.test(kg) || toDecimal(kg).lte(0))) {
    return {
      ...base,
      pieces,
      meters,
      newKg,
      completesPlan,
      error: 'Los kilos van con hasta tres decimales.',
    };
  }

  // D-154: la desviación del kilo declarado **avisa**, con la misma función que el API.
  const deviation =
    kg === '' || newKg === null
      ? null
      : roofingConsumptionDeviation({
          declaredKg: kg,
          theoreticalKg: newKg,
          alreadyDeclaredKg: toDecimal(order.declaredKg).plus(draftDeclaredKg).toFixed(3),
          planKg,
        });

  return { ...base, pieces, meters, newKg, completesPlan, deviation };
}
