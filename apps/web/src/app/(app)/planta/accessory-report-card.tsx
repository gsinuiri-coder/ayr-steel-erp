'use client';

import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  piecesTheoreticalKg,
  TOLERANCE_OVERRIDE_REQUIRED,
  toDecimal,
  type MountedKgExcess,
  type ProductionOrderDto,
  type RoofingBatchOrderDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatQty } from '@/lib/format';
import { useBackdateConfirm } from '@/lib/use-backdate-confirm';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { BackdateConfirmDialog } from '@/components/backdate-confirm-dialog';
import { InfoPopover } from '@/components/info-popover';
import { ReasonDialog } from '@/components/reason-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  EMPTY_OVERRIDE,
  overrideInput,
  ToleranceOverrideRow,
  type ToleranceOverrideState,
} from './tolerance-override';

/**
 * D-343: el reporte de una orden de **accesorio** — metros lineales de bobina, sin detalle de largos.
 *
 * El operario declara directamente los metros de bobina que usó; de ahí salen los kilos teóricos
 * (con el ancho de la bobina montada), lo que entra al kardex del producto terminado (en metros) y
 * lo que se compara contra lo que el pedido encargó. Las **piezas** son solo información: no
 * entran a ningún cálculo. Pasarse de los metros encargados **avisa y no bloquea**.
 *
 * No usa el borrador de reportes (D-191): ese existe para componer largos fila por fila, y un
 * accesorio no tiene largos. «Reportar» y «Reportar y cerrar» van directo al reporte.
 */
export function AccessoryReportCard({
  order,
  coilId,
  operationDate,
  closeKg,
  onCloseKg,
  disabled,
  canCloseOnly,
  closing,
  onCloseOnly,
  onDone,
}: {
  order: RoofingBatchOrderDto;
  /** La bobina elegida cuando la orden tiene varias montadas; `undefined` con una sola. */
  coilId: string | undefined;
  operationDate: string | undefined;
  /** D-089: kilos que la bobina consumió en toda la corrida (de ahí sale el despunte). */
  closeKg: string;
  onCloseKg: (value: string) => void;
  disabled: boolean;
  /** Ya produjo algo: se puede cerrar sin reportar más. */
  canCloseOnly: boolean;
  closing: boolean;
  onCloseOnly: () => void;
  onDone: (updated: ProductionOrderDto, closed: boolean) => void;
}) {
  const [meters, setMeters] = useState('');
  const [piecesCount, setPiecesCount] = useState('');
  const [consumedKg, setConsumedKg] = useState('');
  const [asking, setAsking] = useState(false);
  const reasonToSend = useRef<string | null>(null);
  const [closeMode, setCloseMode] = useState(false);
  /** D-389: las cifras del reporte que pasó la tolerancia del 1 % (las trae el rechazo del API). */
  const [tolerance, setTolerance] = useState<MountedKgExcess | null>(null);
  const [override, setOverride] = useState<ToleranceOverrideState>(EMPTY_OVERRIDE);
  const toleranceOverride = tolerance === null ? null : overrideInput(override, tolerance);
  const key = useIdempotencyKey();

  const coil =
    coilId === undefined
      ? order.coils.length === 1
        ? order.coils[0]
        : undefined
      : order.coils.find((c) => c.coilId === coilId);
  const parsedMeters = /^\d+(\.\d{1,3})?$/.test(meters.trim()) ? toDecimal(meters.trim()) : null;
  // Solo metros mayores a cero: `0` o vacío no es un reporte.
  const typedMeters = parsedMeters?.gt(0) === true ? parsedMeters : null;
  const validMeters = typedMeters !== null;
  const typedPieces = /^\d+$/.test(piecesCount.trim()) ? Number(piecesCount.trim()) : null;
  const validPieces = piecesCount.trim() === '' || (typedPieces !== null && typedPieces > 0);
  // Los kilos teóricos con el ancho de la bobina montada: la misma cuenta que hace el API.
  const theoreticalKg =
    validMeters && coil
      ? piecesTheoreticalKg(
          {
            widthMm: coil.widthMm,
            thicknessMm: coil.thicknessMm,
            densityFactor: coil.densityFactor,
          },
          [{ lengthMm: typedMeters.times(1000).toFixed(2), qty: 1 }],
        )
      : null;
  const ordered = toDecimal(order.planMeters);
  const reported = toDecimal(order.reportedMeters);
  const total = validMeters ? reported.plus(typedMeters) : reported;
  const overOrdered = validMeters && ordered.gt(0) && total.gt(ordered);

  const send = useMutation({
    mutationFn: ({
      close,
      reason,
      confirmBackdate,
    }: {
      close: boolean;
      reason: string | null;
      confirmBackdate: boolean;
    }) => {
      const body = {
        meters: typedMeters?.toFixed(3),
        ...(typedPieces !== null ? { piecesCount: typedPieces } : {}),
        ...(coil ? { coilId: coil.coilId } : {}),
        ...(consumedKg.trim() ? { consumedKg: toDecimal(consumedKg.trim()).toFixed(3) } : {}),
        ...(close && closeKg.trim()
          ? { closeConsumedKg: toDecimal(closeKg.trim()).toFixed(3) }
          : {}),
        ...(close && reason ? { closeReason: reason } : {}),
        // D-389: la casilla y el motivo, solo cuando el API pidió la casilla.
        ...(toleranceOverride === null ? {} : { toleranceOverride }),
        operationDate,
        confirmBackdate: confirmBackdate || undefined,
      };
      return api<ProductionOrderDto>(
        `/production/roofing/${order.orderId}/${close ? 'report-and-close' : 'report'}`,
        { method: 'POST', body: { ...body, idempotencyKey: key.current(JSON.stringify(body)) } },
      );
    },
    onSettled: (_data, error) => {
      key.settle(error ?? undefined);
    },
    onSuccess: (updated, variables) => {
      toast.success(
        variables.close
          ? `${order.code}: reporte guardado y orden cerrada`
          : `${order.code}: reporte guardado`,
      );
      setMeters('');
      setPiecesCount('');
      setConsumedKg('');
      setTolerance(null);
      setOverride(EMPTY_OVERRIDE);
      onDone(updated, variables.close);
    },
    onError: (err, variables) => {
      // D-389: el reporte pasó la tolerancia del 1 %: se muestra el aviso con la casilla y se
      // reenvía con ella. Va **antes** que el motivo del despunte: su mensaje también habla de
      // «motivo», y confundirlos abría el diálogo del despunte en bucle (revisión de cc20).
      if (err instanceof ApiError && err.code === TOLERANCE_OVERRIDE_REQUIRED) {
        setTolerance(err.details?.excess ?? null);
        reasonToSend.current = null;
        if (err.details?.excess === undefined) toast.error(err.message);
        return;
      }
      // D-089: el cierre pide motivo cuando el despunte pasa del umbral, y lo decide el API.
      if (variables.close && err instanceof ApiError && /motivo/i.test(err.message)) {
        setAsking(true);
        return;
      }
      toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar el reporte');
    },
  });

  const submit = useBackdateConfirm(async (confirmBackdate) => {
    await send.mutateAsync({ close: closeMode, reason: reasonToSend.current, confirmBackdate });
  });

  const start = (close: boolean) => {
    setCloseMode(close);
    reasonToSend.current = null;
    void submit.attempt();
  };

  const busy = disabled || send.isPending || closing;
  /** D-389: con el aviso a la vista, se reenvía solo con la casilla y el motivo completos. */
  const toleranceBlocked = tolerance !== null && toleranceOverride === null;
  const canSend =
    validMeters &&
    validPieces &&
    order.coils.length > 0 &&
    (order.coils.length === 1 || coil !== undefined);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          Reportar metros de bobina
          <InfoPopover label="Sobre el reporte de un accesorio">
            Un accesorio no lleva largos: escribe los metros lineales de bobina que usaste. Las
            piezas son solo para tu información y no cambian ningún cálculo.
          </InfoPopover>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {order.coils.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            La orden no tiene ninguna bobina montada: monta una para poder reportar.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Encargado: {formatQty(order.planMeters, 'm')} · reportado:{' '}
              {formatQty(order.reportedMeters, 'm')} · falta:{' '}
              {formatQty(order.remainingMeters, 'm')}
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor={`acc-m-${order.orderId}`}>Metros de bobina usados</Label>
                <Input
                  id={`acc-m-${order.orderId}`}
                  inputMode="decimal"
                  placeholder="0.000"
                  disabled={busy}
                  value={meters}
                  onChange={(e) => {
                    setMeters(e.target.value);
                    // Otros metros, otro exceso: la casilla vale solo para las cifras que se vieron.
                    setTolerance(null);
                    setOverride(EMPTY_OVERRIDE);
                  }}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`acc-p-${order.orderId}`} className="flex items-center gap-1.5">
                  Piezas (opcional)
                  <InfoPopover label="Sobre las piezas">
                    Solo informativo: no entra a ningún cálculo.
                  </InfoPopover>
                </Label>
                <Input
                  id={`acc-p-${order.orderId}`}
                  inputMode="numeric"
                  placeholder="opcional"
                  disabled={busy}
                  value={piecesCount}
                  onChange={(e) => {
                    setPiecesCount(e.target.value);
                  }}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`acc-kg-${order.orderId}`} className="flex items-center gap-1.5">
                  kg consumido (opcional)
                  <InfoPopover label="Sobre el kg consumido">
                    Dato de planta: el kardex sale por el kilo teórico y el consumo real se
                    reconcilia al cerrar.
                  </InfoPopover>
                </Label>
                <Input
                  id={`acc-kg-${order.orderId}`}
                  inputMode="decimal"
                  placeholder={theoreticalKg === null ? 'opcional' : theoreticalKg.toFixed(3)}
                  disabled={busy}
                  value={consumedKg}
                  onChange={(e) => {
                    setConsumedKg(e.target.value);
                  }}
                />
              </div>
            </div>
            <div className="grid gap-1 text-sm">
              {validMeters && theoreticalKg !== null && (
                <p className="text-muted-foreground">
                  {typedMeters.toFixed(3)} m · {theoreticalKg.toFixed(3)} kg teóricos
                </p>
              )}
              {overOrdered && (
                <p className="text-amber-700 dark:text-amber-500">
                  ⚠ Con este reporte suman {total.toFixed(3)} m de bobina y el pedido encargó{' '}
                  {ordered.toFixed(3)} m. Rindió más de lo planeado: se guarda igual y queda
                  anotado.
                </p>
              )}
              {!validPieces && (
                <p className="text-destructive">Las piezas son un número entero mayor a cero.</p>
              )}
            </div>
            <div className="grid gap-1.5 sm:max-w-[14rem]">
              <Label htmlFor={`acc-cierre-${order.orderId}`}>
                kg que consumió la bobina al cerrar (opcional)
              </Label>
              <Input
                id={`acc-cierre-${order.orderId}`}
                inputMode="decimal"
                placeholder="opcional"
                disabled={busy}
                value={closeKg}
                onChange={(e) => {
                  onCloseKg(e.target.value);
                }}
              />
            </div>
            {tolerance !== null && (
              <div
                className="grid gap-3 rounded-lg border border-tone-warning-foreground/40 bg-tone-warning p-3 text-sm text-tone-warning-foreground"
                data-testid="tolerance-override"
              >
                <ToleranceOverrideRow
                  title={`Reporte de ${order.code}`}
                  label={`la cantidad reportada de ${order.code}`}
                  excess={tolerance}
                  value={override}
                  onChange={setOverride}
                  disabled={busy}
                />
              </div>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                aria-label={`Reportar los metros de ${order.code}`}
                disabled={!canSend || busy || toleranceBlocked}
                pending={send.isPending && !closeMode}
                pendingText="Guardando…"
                onClick={() => {
                  start(false);
                }}
              >
                Reportar
              </Button>
              <Button
                aria-label={`Reportar y cerrar ${order.code}`}
                disabled={!canSend || busy || toleranceBlocked}
                pending={send.isPending && closeMode}
                pendingText="Cerrando…"
                onClick={() => {
                  start(true);
                }}
              >
                Reportar y cerrar
              </Button>
              {canCloseOnly && (
                <Button
                  variant="outline"
                  aria-label={`Cerrar ${order.code} sin reportar más`}
                  disabled={busy}
                  pending={closing}
                  pendingText="Cerrando…"
                  onClick={onCloseOnly}
                >
                  Cerrar {order.code} sin reportar más
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>

      <ReasonDialog
        open={asking}
        onOpenChange={setAsking}
        title="Cerrar con despunte alto"
        description="La diferencia entre lo que se declara consumido y los metros reportados sale del inventario como despunte y su costo se reparte entre el producto bueno. Explica por qué."
        confirmLabel="Cerrar la orden"
        pending={send.isPending}
        onConfirm={(reason: string) => {
          setAsking(false);
          reasonToSend.current = reason;
          setCloseMode(true);
          void submit.attempt();
        }}
      />
      <BackdateConfirmDialog
        open={submit.open}
        onOpenChange={(open) => {
          if (!open) submit.close();
        }}
        detail={submit.detail ?? ''}
        pending={send.isPending}
        onConfirm={() => {
          void submit.confirm();
        }}
      />
    </Card>
  );
}
