'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MAX_ORDER_STRIPS,
  MAX_SCRAP_RATIO_WITHOUT_REASON,
  Decimal,
  describePieces,
  piecesMeters,
  piecesTheoreticalKg,
  roofingConsumptionDeviation,
  toDecimal,
  Unit,
  type ProductionOrderDto,
  type RawMaterialWarningDto,
  type RoofingBatchOrderDto,
  type RoofingCoilOptionDto,
  type RoofingPieceDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatQty } from '@/lib/format';
import { EMPTY_PIECE_ROW, mmToMeters, parsePieceRows, type PieceRow } from '@/lib/pieces';
import { invalidateProduction } from '@/lib/production-queries';
import { useBackdateConfirm } from '@/lib/use-backdate-confirm';
import { LINK_CLASSNAME } from '@/lib/utils';
import { BackdateConfirmDialog } from '@/components/backdate-confirm-dialog';
import { OperationDateField } from '@/components/operation-date-field';
import { LengthEditor } from '@/components/production/length-editor';
import { ReasonDialog } from '@/components/reason-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CoilPicker } from './coil-picker';

/**
 * El ciclo completo de **una** orden de coberturas dentro del espacio de producción
 * (D-155, rehecho por D-159).
 *
 * Lo que D-159 cambió, y por qué:
 *
 * - **El plan de corte se edita acá.** El techo real se mide en obra y el largo cambia; hasta
 *   D-158 corregirlo obligaba a irse a la terminal, que era la otra mitad del flujo que esta
 *   pantalla vino a juntar. En una plancha de catálogo se edita **solo la cantidad**: el largo
 *   lo trae el SKU y volver a pedirlo es ofrecer un campo cuya única respuesta correcta el
 *   sistema ya conoce (D-118).
 * - **Montar la bobina rellena el reporte con el plan que falta.** El caso normal es rolar lo
 *   que el pedido pide; escribirlo de nuevo largo por largo era transcribir lo que la pantalla
 *   ya tenía en la mano. Las líneas quedan editables y **se pueden borrar**: lo primero que
 *   hace quien roló la mitad es sacar las que no salieron.
 * - **Guardar y cerrar es una sola transacción** (`POST /report-and-close`). Un pedido genera
 *   una OP por línea (D-084/D-148) y todas se rolan del mismo rollo; mientras la primera siga
 *   abierta con la bobina montada, la segunda no la puede montar. Cerrar en un segundo viaje
 *   dejaba además el reporte escrito sobre una orden a medio cerrar cuando ese viaje fallaba.
 *
 * Lo que **no** cambió: el tope de metros del plan sigue siendo duro (D-146) y las
 * desviaciones del kilo declarado y el faltante del agregado siguen siendo avisos (D-154).
 */

/** Lo que se está por reportar en una orden. Vive **en el padre**, indexado por orden. */
export interface OrderDraft {
  /**
   * Filas del reporte. `null` es "todavía no se sembró": el panel lo rellena con el plan
   * faltante en cuanto la orden tiene bobina, y a partir de ahí es del usuario. Distinguir
   * `null` de `[]` es lo que evita que borrar todas las líneas las haga reaparecer.
   */
  rows: PieceRow[] | null;
  /** D-146: kilos declarados para **este** reporte. Dato de planta, no consumo. */
  consumedKg: string;
  /** D-089: kilos que la bobina consumió en **toda** la corrida; de acá sale el despunte. */
  closeKg: string;
  coilId: string;
  /** Filas del plan de corte mientras se edita. `null` = no se está editando. */
  planRows: PieceRow[] | null;
}

export const EMPTY_DRAFT: OrderDraft = {
  rows: null,
  consumedKg: '',
  closeKg: '',
  coilId: '',
  planRows: null,
};

/**
 * Lo que la última operación de una orden dejó dicho, y que sigue a la vista después de
 * guardar. Los dos son avisos (D-154) y ninguno bloquea nada.
 */
export interface SavedNotes {
  /** Faltantes del agregado que devolvió el API. */
  pool: RawMaterialWarningDto[];
  /**
   * La desviación del kg declarado. La calcula la pantalla con la misma función del API, y
   * hay que **retenerla**: al guardar se limpian los campos, así que el ⚠ que se veía
   * mientras se tipeaba desaparecía justo cuando pasó a ser un hecho registrado.
   */
  note: string | null;
}

export const NO_NOTES: SavedNotes = { pool: [], note: null };

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
   * La lista de órdenes se está refrescando. Bloquea los envíos: tras guardar un reporte, el
   * `order` de esta pestaña sigue siendo el viejo hasta que llega el refetch, así que el
   * editor se re-siembra con los largos que **acaban de reportarse** y el botón queda
   * habilitado sobre un `remainingMeters` que ya no es cierto. Un segundo clic rápido lo
   * duplicaba; el API lo corta por el tope del plan (D-146), pero la pantalla lo invitaba.
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
  /** Motivo del despunte cuando el cierre lo exige (D-089). */
  const [closeReason, setCloseReason] = useState<string | null>(null);
  const [askingReason, setAskingReason] = useState(false);
  /** Qué botón disparó el guardado: decide si el envío cierra la orden o solo reporta. */
  const [pendingClose, setPendingClose] = useState(false);
  /**
   * **Los dos datos que deciden el envío van por `ref` y no por estado.** El botón los fija y
   * dispara el envío en el mismo manejador, y un `setState` no se ve hasta el render
   * siguiente: leídos del estado, «Guardar y cerrar» habría mandado lo que el botón anterior
   * dejó puesto —un reporte sin cierre la primera vez— sin ningún error a la vista.
   * `pendingClose` queda solo para el rótulo, que sí se pinta en el render siguiente.
   */
  const closeMode = useRef(false);
  const reasonToSend = useRef<string | null>(null);
  /**
   * Cuál de los dos cierres está esperando el motivo. El diálogo es uno solo y lo abren dos
   * caminos —«Guardar y cerrar» y «cerrar sin reportar más»—; sin esto, confirmar el motivo
   * en el segundo mandaba el primero, o sea reportaba largos que nadie había tipeado.
   */
  const reasonFor = useRef<'report' | 'close-only'>('report');

  const invalidate = () => {
    invalidateProduction(queryClient, order.orderId);
    void queryClient.invalidateQueries({ queryKey: ['roofing-coils'] });
  };

  const options = useQuery({
    queryKey: ['roofing-coils', order.productId, order.reservationId],
    queryFn: () =>
      api<RoofingCoilOptionDto[]>(
        `/production/roofing/coils?productId=${order.productId}` +
          (order.reservationId === null ? '' : `&reservationId=${order.reservationId}`),
      ),
  });

  const mount = useMutation({
    mutationFn: (id: string) =>
      api<ProductionOrderDto>(`/production/roofing/${order.orderId}/coils`, {
        method: 'POST',
        body: { coilId: id },
      }),
    onSuccess: (updated) => {
      toast.success('Bobina montada en la roladora');
      onNotes({ pool: updated.rawMaterialWarnings ?? [], note: null });
      // D-159: el reporte llega relleno con lo que el plan todavía debe. Montar no cambia el
      // plan, así que los pendientes de este mismo DTO son los correctos.
      onDraft({ rows: seedRows(order) });
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
      // El aviso hablaba del material que esta orden retenía; con la bobina abajo describe
      // un estado que ya no existe.
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
      // El reporte se vuelve a sembrar del plan nuevo: lo que había seguía siendo el viejo.
      onDraft({ planRows: null, rows: null });
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar el plan'),
  });

  const resolved = resolveDraft(order, draft);

  const report = useMutation({
    mutationFn: ({
      pieces,
      close,
      reason,
      confirmBackdate,
    }: {
      pieces: RoofingPieceDto[];
      close: boolean;
      reason: string | null;
      confirmBackdate: boolean;
    }) =>
      api<ProductionOrderDto>(
        `/production/roofing/${order.orderId}/${close ? 'report-and-close' : 'report'}`,
        {
          method: 'POST',
          body: {
            pieces: pieces.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty })),
            ...(resolved.coil ? { coilId: resolved.coil.coilId } : {}),
            ...(draft.consumedKg.trim()
              ? { consumedKg: toDecimal(draft.consumedKg.trim()).toFixed(3) }
              : {}),
            ...(close && reason ? { closeReason: reason } : {}),
            // D-089: el consumo real de toda la corrida, que es de donde sale el despunte.
            ...(close && draft.closeKg.trim()
              ? { closeConsumedKg: toDecimal(draft.closeKg.trim()).toFixed(3) }
              : {}),
            operationDate,
            confirmBackdate: confirmBackdate || undefined,
          },
        },
      ),
    onSuccess: (updated, variables) => {
      toast.success(
        variables.close
          ? `${order.code}: producción reportada y orden cerrada`
          : `${order.code}: producción reportada`,
      );
      // La desviación se guarda **antes** de limpiar el campo: es la misma cuenta que el API
      // acaba de dejar anotada en el reporte, y quien la produjo tiene que seguir viéndola.
      onNotes({ pool: updated.rawMaterialWarnings ?? [], note: resolved.deviation });
      onDraft({ rows: null, consumedKg: '', closeKg: '' });
      // El motivo es de **este** cierre: arrastrarlo al reporte siguiente lo justificaría con
      // la explicación de otra corrida.
      reasonToSend.current = null;
      setCloseReason(null);
      invalidate();
    },
    onError: (err) => {
      // D-089: el cierre pide motivo cuando el despunte pasa del umbral, y lo decide el API
      // (es quien conoce los kilos declarados reporte a reporte). La pantalla lo estima y
      // pregunta antes; cuando la estimación se queda corta, se pregunta acá.
      if (err instanceof ApiError && /motivo/i.test(err.message)) {
        setAskingReason(true);
        return;
      }
      // Cualquier otro fallo deja el motivo escrito sin usar. Arrastrarlo al envío siguiente
      // justificaría con la explicación de esta corrida un despunte que puede ser otro.
      reasonToSend.current = null;
      setCloseReason(null);
      toast.error(err instanceof ApiError ? err.message : 'No se pudo reportar la producción');
    },
  });

  /** El cierre suelto: no queda nada que reportar (el plan se cubrió, o la bobina se acabó). */
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
      setCloseReason(null);
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

  /**
   * Guardar, con o sin cierre. `reason` viaja solo cuando el despunte lo exige, y el diálogo
   * de retro-fecha (D-124) envuelve las dos formas por igual.
   */
  const submit = useBackdateConfirm(async (confirmBackdate) => {
    if (!resolved.pieces) return;
    await report.mutateAsync({
      pieces: resolved.pieces,
      close: closeMode.current,
      reason: reasonToSend.current,
      confirmBackdate,
    });
  });

  const start = (close: boolean) => {
    closeMode.current = close;
    reasonFor.current = 'report';
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
  const closeIsPrimary = resolved.completesPlan || planCovered;
  /**
   * **Cerrar sin reportar más existe siempre que la orden ya haya producido algo**, no solo
   * cuando el plan quedó cubierto. El caso que lo obliga es el más común de todos: la bobina
   * se acabó a los 28 m de un plan de 40, se reporta lo que salió y hay que cerrar la orden
   * para devolverle el rollo a la orden hermana. Atado a `planCovered`, la única salida era
   * bajar el plan a mano hasta que diera cero —o reportar 12 m que nadie produjo—, y el
   * cierre del detalle de la orden ya no está (D-160). El API nunca exigió el plan cubierto.
   */
  const canClose = toDecimal(order.reportedKg).gt(0);
  const pending = report.isPending || closeOnly.isPending || refreshing;

  return (
    // Con la forma de lista, `tabpanel` sería un huérfano: no hay ningún `tablist` que lo
    // contenga y `aria-labelledby` apuntaría a un botón que ya no se anuncia como pestaña.
    // El rótulo se conserva en las dos formas; lo que cambia es solo el rol.
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
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
            <MiniStat label="ML del plan" value={`${order.planMeters} m`} />
            <MiniStat label="ML reportado" value={`${order.reportedMeters} m`} />
            <MiniStat
              label="ML restante"
              value={`${order.remainingMeters} m`}
              tone={planCovered ? 'alert' : 'strong'}
            />
            <MiniStat
              label="kg teórico del plan"
              value={resolved.planKg === null ? '—' : `${resolved.planKg.toFixed(3)} kg`}
              // Dos motivos distintos para el mismo guion, y confundirlos hacía que la
              // pantalla pidiera montar una bobina sobre una orden que tenía dos.
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
          <CardTitle className="text-base">Bobina montada</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {liveCoils.length === 0 && (
            <p className="text-sm text-muted-foreground">
              La orden no tiene ninguna bobina montada: monta una para poder reportar.
            </p>
          )}
          {liveCoils.map((c) => (
            <div
              key={c.coilId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div>
                <div className="font-mono font-medium">{c.coilCode}</div>
                <div className="text-sm text-muted-foreground">
                  {c.widthMm} mm · pendiente {formatQty(c.remainingKg, 'kg')}
                </div>
              </div>
              {/*
                S10/M3: avance de la orden mientras esta bobina está montada — solo lectura,
                sin ningún cálculo nuevo. "ML reportados" es de la orden entera (los reportes
                no se parten por bobina); "kg consumidos" sí es de esta bobina puntual, y ya
                existía en el DTO sin mostrarse.
              */}
              <div className="text-sm text-muted-foreground">
                {formatQty(order.reportedMeters, 'm')} de la orden · {formatQty(c.consumedKg, 'kg')}{' '}
                consumidos de esta bobina
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
                    (RF-33). El API dice lo mismo; apagar el botón evita gastar un 400. */}
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
          ))}

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
              pending={mount.isPending}
              onMount={(id) => {
                mount.mutate(id);
              }}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Reportar lo que salió</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {liveCoils.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Monta una bobina y las líneas del plan que falta aparecen acá, listas para ajustar.
            </p>
          ) : (
            <>
              <LengthEditor
                rows={draft.rows ?? seedRows(order)}
                idPrefix={`reporte-${order.orderId}`}
                disabled={pending}
                onChange={(rows) => {
                  onDraft({ rows });
                }}
              />

              <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-end">
                <div className="grid gap-1.5">
                  <Label htmlFor={`kg-${order.orderId}`}>kg consumido (opcional)</Label>
                  <Input
                    id={`kg-${order.orderId}`}
                    aria-label={`Kilos consumidos de ${order.code}`}
                    inputMode="decimal"
                    className="h-12 text-lg"
                    placeholder={resolved.newKg === null ? 'opcional' : resolved.newKg.toFixed(3)}
                    disabled={pending}
                    value={draft.consumedKg}
                    onChange={(e) => {
                      onDraft({ consumedKg: e.target.value });
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Dato de planta: el kardex sale por el kilo teórico y el consumo real se
                    reconcilia al cerrar.
                  </p>
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
                      Con esto el plan queda cubierto: «Guardar y cerrar» cierra la orden y libera
                      la bobina para la orden siguiente del pedido.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}

          {/*
            D-089: los kilos que la bobina consumió **de verdad** en toda la corrida. Es el
            dato del que sale el despunte, y sin él el cierre asume merma cero. Vive con los
            botones de cierre porque es del cierre, no del reporte: el `kg consumido` de
            arriba es lo declarado de **esta** pasada (D-146).
          */}
          {canClose && (
            <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-start">
              <div className="grid gap-1.5">
                <Label htmlFor={`cierre-kg-${order.orderId}`}>
                  kg que consumió la bobina (opcional)
                </Label>
                <Input
                  id={`cierre-kg-${order.orderId}`}
                  aria-label={`Kilos consumidos al cerrar ${order.code}`}
                  inputMode="decimal"
                  className="h-12 text-lg"
                  placeholder={resolved.closeOnly.consumedFloorKg.toFixed(3)}
                  disabled={pending}
                  value={draft.closeKg}
                  onChange={(e) => {
                    onDraft({ closeKg: e.target.value });
                  }}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Sin este dato se asume que la bobina consumió exactamente los{' '}
                {formatQty(resolved.closeOnly.consumedFloorKg.toFixed(3), 'kg')} teóricos de las
                planchas ya reportadas. La diferencia sale como despunte; el resto de la bobina
                vuelve al almacén.
                {/*
                  Las dos cotas se dicen por separado porque son dos cierres distintos: cerrar
                  ahora no manda los largos del editor, y «Guardar y cerrar» sí. Un solo
                  mensaje —el de la versión con reporte— dejaba bloqueado el cierre suelto por
                  planchas que ese botón no iba a producir.
                */}
                {resolved.closeOnly.closeKgError !== null && (
                  <span className="text-destructive">
                    {' '}
                    Para cerrar sin reportar más: {resolved.closeOnly.closeKgError}
                  </span>
                )}
                {resolved.closeWithReport.closeKgError !== null &&
                  resolved.closeWithReport.closeKgError !== resolved.closeOnly.closeKgError && (
                    <span className="text-destructive">
                      {' '}
                      Para guardar y cerrar: {resolved.closeWithReport.closeKgError}
                    </span>
                  )}
                {resolved.closeOnly.scrapKg.gt(0) && resolved.closeOnly.closeKgError === null && (
                  <>
                    {' '}
                    Despunte al cerrar ahora:{' '}
                    {formatQty(resolved.closeOnly.scrapKg.toFixed(3), 'kg')}.
                  </>
                )}
              </p>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Button
              variant={closeIsPrimary ? 'outline' : 'default'}
              className="h-16 text-lg"
              disabled={resolved.pieces === null || resolved.error !== null || pending}
              onClick={() => {
                start(false);
              }}
            >
              {report.isPending && !pendingClose ? 'Guardando…' : `Guardar ${order.code}`}
            </Button>
            <Button
              variant={closeIsPrimary ? 'default' : 'outline'}
              className="h-16 text-lg"
              disabled={
                resolved.pieces === null ||
                resolved.error !== null ||
                resolved.closeWithReport.closeKgError !== null ||
                pending
              }
              onClick={() => {
                start(true);
              }}
            >
              {report.isPending && pendingClose ? 'Cerrando…' : 'Guardar y cerrar'}
            </Button>
            <OperationDateField value={operationDate} onChange={onOperationDate} />
          </div>

          {canClose && (
            <Button
              variant="outline"
              className="h-12 justify-self-start"
              aria-label={`Cerrar ${order.code} sin reportar más`}
              disabled={pending || resolved.closeOnly.closeKgError !== null}
              onClick={() => {
                reasonFor.current = 'close-only';
                closeOnly.mutate(closeReason);
              }}
            >
              {closeOnly.isPending
                ? 'Cerrando…'
                : `Cerrar ${order.code} sin reportar más${planCovered ? '' : ' (la bobina se acabó)'}`}
            </Button>
          )}
        </CardContent>
      </Card>

      <ReasonDialog
        open={askingReason}
        onOpenChange={setAskingReason}
        title="Cerrar con despunte alto"
        // Con las cifras concretas, no solo el porcentaje: es el momento en que el encargado
        // decide si la merma que va a firmar es la que de verdad ocurrió.
        description={`Las planchas reportadas representan ${formatQty(
          (reasonFor.current === 'close-only'
            ? resolved.closeOnly
            : resolved.closeWithReport
          ).consumedFloorKg.toFixed(3),
          'kg',
        )} y se declara un consumo mayor: la diferencia —más del ${String(MAX_SCRAP_RATIO_WITHOUT_REASON * 100)} %— sale del inventario como despunte y su costo se reparte entre el producto bueno. Explica por qué.`}
        confirmLabel="Cerrar la orden"
        pending={pending}
        onConfirm={(reason: string) => {
          // El motivo se guarda en el `ref` y se reintenta por **el mismo camino** que el
          // botón: así el reintento sigue pasando por el guardrail cronológico (D-124) en
          // vez de mandar `confirmBackdate: false` a mano y perder el diálogo de retro-fecha.
          reasonToSend.current = reason;
          setCloseReason(reason);
          setAskingReason(false);
          if (reasonFor.current === 'close-only') closeOnly.mutate(reason);
          else start(true);
        }}
      />

      <BackdateConfirmDialog
        open={submit.open}
        onOpenChange={(open) => {
          if (!open) submit.close();
        }}
        detail={submit.detail ?? ''}
        pending={report.isPending}
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
        <CardTitle className="text-base">Plan de corte</CardTitle>
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
            className="h-12 justify-self-start"
            aria-label={`Ajustar el plan de corte de ${order.code}`}
            onClick={startEditing}
          >
            Ajustar el plan
          </Button>
        )}

        {editing && rows !== null && (
          <div className="grid gap-3 rounded-lg border p-3">
            <p className="text-sm text-muted-foreground">
              El plan es una intención: lo que mueve inventario son los largos que reportes. Es
              también el tope de lo que se puede reportar (D-146), así que si de verdad hay que
              producir más, se cambia acá.
            </p>
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
                  className="h-12 text-lg"
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
                className="h-12"
                disabled={parsed === null || !parsed.ok || pending}
                onClick={() => {
                  if (parsed?.ok) onSave(parsed.pieces);
                }}
              >
                {pending ? 'Guardando…' : 'Guardar plan'}
              </Button>
              <Button
                variant="outline"
                className="h-12"
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

/** El plan que todavía falta, como filas del editor. Vacío ⇒ una fila en blanco. */
function seedRows(order: RoofingBatchOrderDto): PieceRow[] {
  if (order.remainingPieces.length === 0) return [EMPTY_PIECE_ROW];
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
  /** `true` cuando lo que se va a reportar cubre exactamente lo que falta del plan. */
  completesPlan: boolean;
  /** El API va a exigir motivo para el despunte de este cierre (D-089). */
  needsCloseReason: boolean;
  /**
   * D-089: las cotas del kg declarado, **una por cada forma de cerrar**.
   *
   * No son la misma cuenta y confundirlas dejaba inservible justo el botón que más se usa:
   * el piso es lo que las planchas reportadas representan, y «Guardar y cerrar» reporta unas
   * cuantas más que «cerrar sin reportar más» no manda. Con un solo piso —el de la versión
   * con reporte— el cierre suelto exigía declarar kilos por planchas que no iban a salir, y
   * como el editor se re-siembra solo con el plan que falta, el caso normal («la bobina se
   * acabó, cierro con lo que salió») quedaba bloqueado sin salida visible.
   */
  closeOnly: CloseBounds;
  closeWithReport: CloseBounds;
  /** Lo que el API también rechaza: el botón se apaga. */
  error: string | null;
  /** Lo que el API **acepta** y anota igual (D-154): se muestra y no bloquea. */
  deviation: string | null;
}

/**
 * Las dos cotas del consumo declarado al cerrar (D-089), comprobadas acá porque el API las
 * comprueba **dentro** de la transacción del cierre: descubrirlas con un 400 es enterarse
 * después de una espera que la pantalla ya sabía perdida, y sobre un campo que —hasta que se
 * repuso con D-159— ni siquiera existía para corregir.
 *
 * `extraReportedKg` son los kilos del reporte que va en el mismo envío («Guardar y cerrar»):
 * suben el piso, y no cambian el techo — lo que el reporte le saca al saldo de la bobina se
 * lo suma a lo ya consumido.
 */
interface CloseBounds {
  /**
   * El piso del consumo declarable: lo que las planchas ya reportadas —más las de este envío,
   * cuando el envío también reporta— representan. Es lo que el cierre asume si nadie declara
   * nada, o sea despunte cero.
   */
  consumedFloorKg: Decimal;
  /** Por qué el kg declarado no sirve. `null` cuando está vacío o dentro de las cotas. */
  closeKgError: string | null;
  /** Lo declarado menos el piso: lo que va a salir del inventario como despunte. */
  scrapKg: Decimal;
}

function closeBounds(
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
      closeKgError: `Las planchas reportadas ya consumieron ${floor.toFixed(3)} kg: no se puede declarar menos.`,
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

  // Sin reporte pendiente las dos formas de cerrar coinciden: el piso es lo ya reportado.
  const closeOnly = closeBounds(order, draft.closeKg, new Decimal(0));

  const base: ResolvedDraft = {
    coil,
    planKg,
    pieces: null,
    meters: new Decimal(0),
    newKg: null,
    completesPlan: false,
    needsCloseReason: false,
    closeOnly,
    closeWithReport: closeOnly,
    error: null,
    deviation: null,
  };

  if (order.coils.length === 0) return base;
  // El plan ya está cubierto y nadie tipeó nada: el editor está vacío porque no hay nada que
  // reportar, no porque falte llenarlo. Sin esto, una orden lista para cerrar mostraba
  // «Escribe al menos un largo» en rojo sobre la única acción que ya no corresponde.
  if (draft.rows === null && order.remainingPieces.length === 0) return base;
  const parsed = parsePieceRows(draft.rows ?? seedRows(order));
  if (!parsed.ok) return { ...base, error: parsed.reason };
  if (order.coils.length > 1 && coil === undefined) {
    return { ...base, error: 'Indica de qué bobina salieron.' };
  }

  const pieces = parsed.pieces;
  const meters = piecesMeters(pieces);
  const newKg = geometry === null ? null : piecesTheoreticalKg(geometry, pieces);
  const completesPlan = meters.equals(toDecimal(order.remainingMeters));

  // D-146: el tope del plan sigue siendo duro. Producir de más se resuelve ajustando el plan
  // —que ahora se edita en esta misma pantalla—, no reportando por encima.
  if (meters.gt(toDecimal(order.remainingMeters))) {
    return {
      ...base,
      pieces,
      meters,
      newKg,
      error: `Del plan quedan ${order.remainingMeters} m y esto suma ${meters.toFixed(3)} m: ajusta el plan de corte si de verdad hay que producir más.`,
    };
  }

  // El material montado corta acá y no solo en el servidor: el API lo comprueba dentro de la
  // transacción del reporte, o sea después de una espera que la pantalla ya sabía perdida.
  if (coil !== undefined && newKg?.gt(toDecimal(coil.remainingKg)) === true) {
    return {
      ...base,
      pieces,
      meters,
      newKg,
      completesPlan,
      error: `${coil.coilCode} tiene ${coil.remainingKg} kg montados y esto necesita ${newKg.toFixed(3)} kg: monta más material.`,
    };
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

  // D-154: la desviación del kilo declarado **avisa**, con la misma función que el API usa
  // para dejarla anotada en el reporte. Dos redacciones serían dos umbrales distintos.
  const deviation =
    kg === '' || newKg === null
      ? null
      : roofingConsumptionDeviation({
          declaredKg: kg,
          theoreticalKg: newKg,
          alreadyDeclaredKg: order.declaredKg,
          planKg,
        });

  // Con el reporte de este envío contado: «Guardar y cerrar» sube el piso del consumo con
  // los kilos que está por reportar. `closeOnly` sigue siendo el del cierre suelto.
  const closeWithReport = closeBounds(order, draft.closeKg, newKg ?? new Decimal(0));

  // D-089: lo declarado menos lo que las planchas representan es el despunte, y por encima
  // del umbral el API pide motivo. Lo explícito manda —igual que en el API—; sin él, la
  // pantalla **estima** con lo declarado reporte a reporte, y como el API suma de otra forma
  // puede llegar a una cifra mayor: por eso el 400 sigue teniendo su camino de vuelta.
  const floor = closeWithReport.consumedFloorKg;
  const declared = draft.closeKg.trim()
    ? floor.plus(closeWithReport.scrapKg)
    : Decimal.max(toDecimal(order.declaredKg).plus(kg === '' ? '0' : kg), floor);
  const scrap = declared.minus(floor);
  const needsCloseReason =
    declared.gt(0) && scrap.div(declared).gt(toDecimal(String(MAX_SCRAP_RATIO_WITHOUT_REASON)));

  return {
    ...base,
    closeWithReport,
    pieces,
    meters,
    newKg,
    completesPlan,
    needsCloseReason,
    deviation,
  };
}
