'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Decimal,
  MAX_SCRAP_RATIO_WITHOUT_REASON,
  sum,
  toDecimal,
  type PlantClosePreviewDto,
  type ProductionOrderDto,
  type RoofingBatchOrderDto,
} from '@ayr/shared';
import {
  accessoryBlock,
  accessoryFill,
  EMPTY_ACCESSORY_EDIT,
  typedMeters,
  type AccessoryEdit,
} from '@/lib/accessory-blocks';
import { api, ApiError } from '@/lib/api';
import { formatKg, formatMeters, formatQtyAsIs } from '@/lib/format';
import { planProgress } from '@/lib/plan-progress';
import { errorMessage, toast } from '@/lib/notify';
import { invalidateProduction } from '@/lib/production-queries';
import { useBackdateConfirm } from '@/lib/use-backdate-confirm';

import { cn } from '@/lib/utils';
import { BackdateConfirmDialog } from '@/components/backdate-confirm-dialog';
import { OperationDateField } from '@/components/operation-date-field';
import { ReasonDialog } from '@/components/reason-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AutoConfirmBlock, BandHeader, ClosePreviewBlock, Stat } from './produce-blocks';
import { CloseButton, CloseHint, CoilStatusBadge, PlanProgressBar } from './plan-progress-view';
import { newDraftKey } from './use-block-drafts';
import {
  EMPTY_OVERRIDE,
  overrideInput,
  ToleranceOverrideRow,
  type ToleranceOverrideState,
} from './tolerance-override';

/**
 * cc35 (ESPEC §2) — **producir un accesorio con el modelo M.** Sin plan de corte: la banda se
 * llama «Avance» (pedido, registrado, falta) y no hay «Ajustar el plan». Un bloque por bobina, en
 * el orden de montaje, con los metros de bobina que salieron, las piezas (opcionales, solo
 * información) y los kg consumidos (opcional). El último se llena solo con lo que falta.
 *
 * D-559: el borrador de reportes guarda largos, no metros, y llevarle metros exige una migración.
 * Sin ella, lo escrito se guarda **en este navegador** (sobrevive a un refresco) y «Registrar»
 * manda un parte por bloque, en orden (`POST …/report`, como hoy). «Registrar y cerrar» manda los
 * bloques anteriores y el último junto con el cierre (`…/report-and-close`, con su vista previa).
 * No es todo o nada entre bloques: un rechazo detiene la serie en ese bloque y los anteriores
 * quedan registrados, a la vista en la bobina («ya registrado»).
 */

const STORAGE_PREFIX = 'ayr:cc35:accesorio:';

function loadEdits(orderId: string): Record<string, AccessoryEdit> {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + orderId);
    const stored = raw === null ? {} : (JSON.parse(raw) as Record<string, AccessoryEdit>);
    // Un bloque que ya se registró (su parte respondió) no vuelve: la orden releída ya lo trae.
    return Object.fromEntries(Object.entries(stored).filter(([, e]) => e.sent !== true));
  } catch {
    return {};
  }
}

/** Lo guardado tal cual, con los bloques ya registrados. */
function loadEditsRaw(orderId: string): Record<string, AccessoryEdit> {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + orderId);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, AccessoryEdit>);
  } catch {
    return {};
  }
}

function saveEdits(orderId: string, edits: Record<string, AccessoryEdit>): void {
  try {
    if (Object.keys(edits).length === 0) window.localStorage.removeItem(STORAGE_PREFIX + orderId);
    else window.localStorage.setItem(STORAGE_PREFIX + orderId, JSON.stringify(edits));
  } catch {
    // Sin almacenamiento (ventana privada, bloqueado): lo escrito vive solo en la pantalla.
  }
}

export function ProduceAccessory({
  order,
  refreshing,
  operationDate,
  onOperationDate,
  onUpdated,
  mountButton,
  releaseCoil,
  releasing,
}: {
  order: RoofingBatchOrderDto;
  refreshing: boolean;
  operationDate: string | undefined;
  onOperationDate: (value: string | undefined) => void;
  onUpdated: (updated: ProductionOrderDto | null) => void;
  mountButton: React.ReactNode;
  releaseCoil: (consumptionId: string) => void;
  releasing: boolean;
}) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    invalidateProduction(queryClient, order.orderId);
  };
  // Se lee al crear el estado (el panel se monta por orden y ya con los datos del API, nunca en el
  // primer pintado del servidor): con un efecto de carga, el doble montaje de desarrollo leía el
  // almacenamiento después de que el efecto de guardado lo vaciara.
  const [edits, setEdits] = useState<Record<string, AccessoryEdit>>(() =>
    typeof window === 'undefined' ? {} : loadEdits(order.orderId),
  );
  useEffect(() => {
    saveEdits(order.orderId, edits);
  }, [edits, order.orderId]);

  const [overrides, setOverrides] = useState<Record<string, ToleranceOverrideState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [preview, setPreview] = useState<PlantClosePreviewDto | null>(null);
  const [askingReason, setAskingReason] = useState(false);
  const reason = useRef<string | null>(null);
  const closing = useRef(false);
  const backdate = useRef(false);
  const [sending, setSending] = useState(false);

  const coils = order.coils;
  const lastCoil = coils[coils.length - 1];
  const blocks = coils.map((coil, i) => {
    const last = coil.coilId === lastCoil?.coilId;
    const edit = edits[coil.coilId];
    const others = coils
      .filter((c) => c.coilId !== coil.coilId && c.coilId !== lastCoil?.coilId)
      .map((c) => typedMeters(edits[c.coilId]?.meters ?? ''));
    const derived = last && edit === undefined;
    const fill = derived ? accessoryFill(order.remainingMeters, others) : null;
    const shown: AccessoryEdit = derived
      ? { ...EMPTY_ACCESSORY_EDIT, meters: fill?.gt(0) ? fill.toFixed(3) : '' }
      : (edit ?? EMPTY_ACCESSORY_EDIT);
    return { coil, index: i + 1, last, derived, edit: shown, check: accessoryBlock(coil, shown) };
  });
  /** D-575: el último bloque llenado solo y sin confirmar: no se registra hasta confirmarlo. */
  const autoBlock = blocks.find((b) => b.derived && b.check.meters !== null);
  const registrable = blocks.filter((b) => !b.derived);
  const progress = planProgress({
    planMeters: order.planMeters,
    reportedMeters: order.reportedMeters,
    plan: null,
    draft: sum(registrable.map((b) => b.check.meters ?? new Decimal(0))),
    auto: autoBlock?.check.meters ?? new Decimal(0),
  });
  /** D-575 (tablero `CerrarBarra`): «Qué va a pasar» esperando la casilla del bloque llenado solo. */
  const [askingAuto, setAskingAuto] = useState<string | null>(null);
  const [autoIncluded, setAutoIncluded] = useState<string | null>(null);
  const autoLabel = (b: (typeof blocks)[number]) =>
    `${formatMeters(b.check.meters ?? '0')} que se llenaron solos en la bobina ${b.coil.coilCode}`;
  /** «Sí, salió así»: lo llenado pasa a ser lo escrito (y se guarda en el navegador, D-559). */
  const confirmAuto = () => {
    if (autoBlock !== undefined) setEdit(autoBlock.coil.coilId, autoBlock.edit);
  };

  /** Escribir en un bloque cambia su contenido: su clave de idempotencia deja de valer. */
  const setEdit = (coilId: string, next: AccessoryEdit) => {
    setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== coilId)));
    const { key: _old, ...rest } = next;
    setEdits((prev) => ({ ...prev, [coilId]: rest }));
  };

  /**
   * D-182: la clave de idempotencia de un parte vive **con lo escrito** (en el navegador, D-559):
   * un reintento —también tras recargar, si la respuesta se perdió— no duplica el parte, y un parte
   * nuevo con las mismas cifras (después de registrar el anterior) lleva otra.
   */
  const keyFor = (b: (typeof blocks)[number]): string => {
    if (b.edit.key !== undefined) return b.edit.key;
    const key = newDraftKey();
    const next = { ...edits, [b.coil.coilId]: { ...b.edit, key } };
    saveEdits(order.orderId, next);
    setEdits(next);
    return key;
  };

  const bodyOf = (b: (typeof blocks)[number], extra: object = {}) => {
    const override = overrideInput(overrides[b.coil.coilId], b.check.figures.excess);
    const body = {
      coilId: b.coil.coilId,
      meters: b.check.meters?.toFixed(3),
      ...(b.check.pieces === null ? {} : { piecesCount: b.check.pieces }),
      ...(b.edit.consumedKg.trim() === ''
        ? {}
        : { consumedKg: toDecimal(b.edit.consumedKg.trim()).toFixed(3) }),
      ...(override === null ? {} : { toleranceOverride: override }),
      operationDate,
      confirmBackdate: backdate.current || undefined,
      ...extra,
    };
    return { ...body, idempotencyKey: keyFor(b) };
  };

  /** Un bloque cuyo parte ya respondió: queda marcado (y guardado) hasta releer la orden. */
  const markSent = (coilId: string, edit: AccessoryEdit) => {
    const stored = loadEditsRaw(order.orderId);
    stored[coilId] = { ...edit, sent: true };
    saveEdits(order.orderId, stored);
    setEdits((prev) => ({ ...prev, [coilId]: { ...edit, sent: true } }));
  };

  /** Manda en orden los partes de `list`; para en el primero que el API rechaza. */
  const sendReports = async (list: typeof blocks): Promise<boolean> => {
    const sent: string[] = [];
    let ok = true;
    let lastResponse: ProductionOrderDto | null = null;
    for (const b of list) {
      if (b.check.meters === null || b.edit.sent === true) continue;
      try {
        lastResponse = await api<ProductionOrderDto>(
          `/production/roofing/${order.orderId}/report`,
          {
            method: 'POST',
            body: bodyOf(b),
          },
        );
        sent.push(b.coil.coilId);
        // Marcado en el almacenamiento en el acto: un F5 o un cambio de orden a mitad de la serie
        // no lo vuelve a mandar.
        markSent(b.coil.coilId, b.edit);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'BACKDATE_OUT_OF_ORDER' && sent.length === 0) {
          throw err;
        }
        setErrors((prev) => ({
          ...prev,
          [b.coil.coilId]: errorMessage(err, 'No se pudo registrar esta bobina'),
        }));
        ok = false;
        break;
      }
    }
    if (sent.length > 0) {
      // Lo registrado se suelta recién con la orden releída: si no, el último bloque se volvía a
      // llenar con lo que faltaba **antes** de estos partes (revisión de cc35).
      invalidateProduction(queryClient, order.orderId);
      await queryClient.refetchQueries({ queryKey: ['roofing-batch'] });
      setEdits((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([id]) => !sent.includes(id))),
      );
      // D-154: los avisos del agregado que devolvió el último parte.
      onUpdated(lastResponse);
    }
    return ok;
  };

  const lastBlock = blocks[blocks.length - 1];
  const closeBody = () => ({
    ...(reason.current ? { reason: reason.current } : {}),
    operationDate,
    confirmBackdate: backdate.current || undefined,
  });
  /** El cierre: con metros en el último bloque, «reportar y cerrar»; si no, el cierre suelto. */
  const closePath = () =>
    lastBlock?.check.meters !== null && lastBlock !== undefined
      ? {
          path: `/production/roofing/${order.orderId}/report-and-close`,
          body: bodyOf(lastBlock, reason.current ? { closeReason: reason.current } : {}),
        }
      : { path: `/production/roofing/${order.orderId}/close`, body: closeBody() };

  const onCloseError = (err: unknown) => {
    if (
      err instanceof ApiError &&
      /motivo/i.test(err.message) &&
      err.code !== 'TOLERANCE_OVERRIDE_REQUIRED'
    ) {
      setAskingReason(true);
      return;
    }
    reason.current = null;
    const message = errorMessage(err, 'No se pudo cerrar la orden');
    if (lastBlock !== undefined)
      setErrors((prev) => ({ ...prev, [lastBlock.coil.coilId]: message }));
    toast.error(message);
  };

  /** Lo que «Qué va a pasar» calculó: se confirma exactamente eso (D-453). */
  const pendingClose = useRef<{ path: string; body: object } | null>(null);
  const previewClose = useMutation({
    mutationFn: () => {
      const request = closePath();
      pendingClose.current = request;
      return api<PlantClosePreviewDto>(`${request.path}/preview`, {
        method: 'POST',
        body: request.body,
      });
    },
    onSuccess: setPreview,
    onError: onCloseError,
  });
  const close = useMutation({
    mutationFn: () => {
      const request = pendingClose.current ?? closePath();
      return api<ProductionOrderDto>(request.path, { method: 'POST', body: request.body });
    },
    onSuccess: (updated) => {
      toast.success(`${order.code}: producción registrada y orden cerrada`);
      setEdits({});
      setPreview(null);
      reason.current = null;
      onUpdated(updated);
      invalidate();
    },
    onError: onCloseError,
  });

  const run = useBackdateConfirm(async (confirmBackdate) => {
    backdate.current = confirmBackdate;
    setSending(true);
    try {
      if (closing.current) {
        const before = blocks.filter((b) => !b.last);
        if (!(await sendReports(before))) return;
        await previewClose.mutateAsync();
        return;
      }
      // D-575: el bloque llenado solo y sin confirmar no se manda.
      if (await sendReports(registrable)) {
        toast.success(`${order.code}: producción registrada`);
      }
      invalidate();
    } finally {
      setSending(false);
    }
  });

  const pendingOverride = registrable.find(
    (b) =>
      b.check.figures.excess !== null &&
      overrideInput(overrides[b.coil.coilId], b.check.figures.excess) === null,
  );
  const blocking = registrable.find((b) => b.check.error !== null);

  const start = (shouldClose: boolean) => {
    setAttempted(true);
    closing.current = shouldClose;
    reason.current = null;
    if (blocking !== undefined || pendingOverride !== undefined) return;
    if (!shouldClose && registrable.every((b) => b.check.meters === null)) {
      toast.warning('No hay nada escrito para registrar.');
      return;
    }
    // D-573: con los metros de la orden incompletos no se cierra (el API tampoco deja).
    if (shouldClose && !progress.canClose) return;
    // D-575: «Qué va a pasar» pide confirmar el bloque llenado solo antes de calcular.
    if (shouldClose && autoBlock !== undefined) {
      setAskingAuto(autoLabel(autoBlock));
      return;
    }
    void run.attempt();
  };

  const confirmAutoAndPreview = () => {
    confirmAuto();
    setAutoIncluded(askingAuto);
    setAskingAuto(null);
    void run.attempt();
  };

  // Con «Qué va a pasar» a la vista no se edita: se confirma lo que el resumen dijo.
  const busy =
    sending ||
    previewClose.isPending ||
    close.isPending ||
    preview !== null ||
    askingAuto !== null ||
    refreshing ||
    releasing;
  const ordered = toDecimal(order.planMeters);
  const typedTotal = sum(blocks.map((b) => b.check.meters ?? toDecimal('0')));
  const covered = toDecimal(order.reportedMeters).plus(typedTotal);
  const scrapTotal = sum(blocks.map((b) => b.check.figures.scrapKg));
  const consumedTotal = sum(blocks.map((b) => b.check.figures.outKg.plus(b.check.figures.scrapKg)));
  const theoretical =
    coils[0] === undefined
      ? null
      : accessoryBlock(coils[0], { ...EMPTY_ACCESSORY_EDIT, meters: order.planMeters }).figures
          .theoreticalKg;

  return (
    <div className="grid gap-4">
      <section className="grid gap-2" aria-label={`Avance de ${order.code}`}>
        <BandHeader title="Avance" />
        <div className="grid gap-2.5 px-1">
          <div className="flex flex-wrap gap-x-8 gap-y-2 rounded-lg bg-muted/60 px-4 py-2.5">
            <Stat
              label="Pedido"
              value={`${order.productName} · ${formatMeters(order.planMeters)}`}
            />
            <Stat label="Teórico" value={theoretical === null ? '—' : formatKg(theoretical)} />
          </div>
          <PlanProgressBar view={progress} label={`Avance de ${order.code}`} />
        </div>
        <p className="text-xs text-muted-foreground">
          Un accesorio no tiene plan de corte: se escriben directo los metros que salieron de cada
          bobina hasta completar lo del pedido. Piezas es opcional y solo informativo.
        </p>
      </section>

      <section className="grid gap-2" aria-label={`Bobinas de ${order.code}`}>
        <BandHeader title={`Bobinas · ${String(blocks.length)}`}>{mountButton}</BandHeader>
        {blocks.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">
            La orden no tiene ninguna bobina montada: monta una y lo que falta del pedido aparece
            acá.
          </p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {blocks.map((b) => {
              const { figures } = b.check;
              const label = `la bobina ${String(b.index)} (${b.coil.coilCode})`;
              const error = errors[b.coil.coilId] ?? b.check.error;
              const override = overrides[b.coil.coilId] ?? EMPTY_OVERRIDE;
              const auto = b === autoBlock;
              return (
                <div
                  key={b.coil.coilId}
                  data-testid={`bloque-${b.coil.coilCode}`}
                  data-auto={auto ? 'sin-confirmar' : undefined}
                  className={cn(
                    'grid content-start gap-2.5 rounded-xl border p-3.5',
                    auto && 'border-dashed border-tone-warning-foreground bg-tone-warning/40',
                    error !== null && 'border-destructive/50',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-xs text-muted-foreground">
                        Bobina {b.index} · saldo {formatQtyAsIs(b.coil.remainingKg, 'kg')}
                        {toDecimal(b.coil.consumedKg).gt(0) && (
                          <> · ya registrado {formatQtyAsIs(b.coil.consumedKg, 'kg')}</>
                        )}
                      </div>
                      <div className="font-mono font-semibold">{b.coil.coilCode}</div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
                      {auto ? (
                        <span className="font-semibold text-tone-warning-foreground">
                          Llenado solo · sin confirmar
                        </span>
                      ) : (
                        <CoilStatusBadge
                          inDraft={!b.derived && b.check.meters !== null}
                          registered={toDecimal(b.coil.reportedMeters).gt(0)}
                        />
                      )}
                      <span
                        className={cn(
                          'font-semibold',
                          figures.terminated ? 'text-tone-warning-foreground' : 'text-primary',
                        )}
                      >
                        {figures.terminated ? 'se terminó' : 'sigue montada'}
                      </span>
                      {toDecimal(b.coil.consumedKg).isZero() &&
                        (b.derived || b.edit.meters.trim() === '') && (
                          <Button
                            variant="link"
                            size="sm"
                            aria-label={`Bajar la bobina ${b.coil.coilCode} de ${order.code}`}
                            disabled={busy}
                            onClick={() => {
                              releaseCoil(b.coil.consumptionId);
                            }}
                          >
                            Bajar
                          </Button>
                        )}
                    </div>
                  </div>
                  {toDecimal(b.coil.reportedMeters).gt(0) && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      Registrado: {formatMeters(b.coil.reportedMeters)} de bobina
                    </p>
                  )}
                  {auto && (
                    <div className="grid gap-1.5" data-testid="bloque-llenado-solo">
                      <p className="text-muted-foreground tabular-nums">
                        {formatMeters(b.check.meters ?? '0')}, lo que falta del pedido
                      </p>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Sí, salió así en ${label}`}
                          disabled={busy}
                          onClick={confirmAuto}
                        >
                          Sí, salió así
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Vaciar ${label}`}
                          disabled={busy}
                          onClick={() => {
                            setEdit(b.coil.coilId, EMPTY_ACCESSORY_EDIT);
                          }}
                        >
                          Vaciar
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className="overflow-hidden rounded-lg border">
                    <div className="grid grid-cols-2 gap-2 bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground">
                      <span>Metros de bobina</span>
                      <span className="text-right">Piezas · opcional</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 border-t px-2.5 py-1.5">
                      <div className="relative">
                        <Input
                          aria-label={`Metros de ${label}`}
                          inputMode="decimal"
                          className="h-8 pr-7 text-right tabular-nums"
                          disabled={busy}
                          value={b.edit.meters}
                          onChange={(e) => {
                            setEdit(b.coil.coilId, { ...b.edit, meters: e.target.value });
                          }}
                        />
                        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground">
                          m
                        </span>
                      </div>
                      <Input
                        aria-label={`Piezas de ${label}`}
                        inputMode="numeric"
                        className="h-8 text-right tabular-nums"
                        disabled={busy}
                        value={b.edit.pieces}
                        onChange={(e) => {
                          setEdit(b.coil.coilId, { ...b.edit, pieces: e.target.value });
                        }}
                      />
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {figures.meters.toFixed(3)} m · teórico {figures.theoreticalKg.toFixed(3)} kg
                  </p>
                  <div className="flex items-center gap-2">
                    <label className="text-sm" htmlFor={`kg-acc-${b.coil.coilId}`}>
                      kg consumidos <span className="text-muted-foreground">· opcional</span>
                    </label>
                    <div className="relative w-36">
                      <Input
                        id={`kg-acc-${b.coil.coilId}`}
                        aria-label={`kg consumidos de ${label}`}
                        inputMode="decimal"
                        className="h-8 pr-8 text-right tabular-nums"
                        placeholder={figures.theoreticalKg.toFixed(3)}
                        disabled={busy}
                        value={b.edit.consumedKg}
                        onChange={(e) => {
                          setEdit(b.coil.coilId, { ...b.edit, consumedKg: e.target.value });
                        }}
                      />
                      <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground">
                        kg
                      </span>
                    </div>
                  </div>
                  <div className="flex justify-between text-sm tabular-nums">
                    <span>
                      Despunte{' '}
                      <span className="font-semibold">{figures.scrapKg.toFixed(3)} kg</span>
                    </span>
                    <span>
                      Queda <span className="font-semibold">{figures.leftKg.toFixed(3)} kg</span>
                    </span>
                  </div>
                  {figures.note !== null && (
                    <p role="status" className="text-xs text-sky-700 dark:text-sky-400">
                      ℹ {figures.note}
                    </p>
                  )}
                  {figures.deviation !== null && (
                    <p className="text-xs text-tone-warning-foreground">⚠ {figures.deviation}</p>
                  )}
                  {figures.excess !== null && (
                    <div
                      data-testid="tolerance-override"
                      className={cn(
                        'rounded-lg border border-tone-warning-foreground/40 bg-tone-warning p-2.5 text-xs text-tone-warning-foreground',
                        attempted &&
                          overrideInput(override, figures.excess) === null &&
                          'ring-2 ring-destructive/50',
                      )}
                    >
                      <ToleranceOverrideRow
                        title={`Bobina ${String(b.index)} (${b.coil.coilCode})`}
                        label={label}
                        excess={figures.excess}
                        value={override}
                        onChange={(next) => {
                          setOverrides((prev) => ({ ...prev, [b.coil.coilId]: next }));
                        }}
                        disabled={busy}
                      />
                    </div>
                  )}
                  {error !== null && (
                    <p role="alert" className="text-sm text-destructive">
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {blocks.length > 0 && (
        <div
          role="status"
          data-testid="cuadre-plan"
          className={cn(
            'flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm',
            covered.equals(ordered)
              ? 'border-tone-done-foreground/30 bg-tone-done text-tone-done-foreground'
              : 'bg-muted/40',
          )}
        >
          <span>
            {blocks.length === 1 ? '1 bobina' : `${String(blocks.length)} bobinas`} ={' '}
            <span className="font-semibold tabular-nums">
              {covered.toFixed(3)} de {ordered.toFixed(3)} m
            </span>{' '}
            del pedido
          </span>
          <span>
            Despunte total{' '}
            <span className="font-semibold tabular-nums">{scrapTotal.toFixed(3)} kg</span>
            {consumedTotal.gt(0) && <> · {scrapTotal.div(consumedTotal).times(100).toFixed(1)} %</>}
          </span>
        </div>
      )}

      {askingAuto !== null && (
        <AutoConfirmBlock
          label={askingAuto}
          pending={sending}
          onConfirm={confirmAutoAndPreview}
          onBack={() => {
            setAskingAuto(null);
          }}
        />
      )}

      {preview !== null && (
        <ClosePreviewBlock
          key={JSON.stringify(preview)}
          order={order}
          preview={preview}
          autoIncluded={autoIncluded}
          pending={close.isPending}
          onBack={() => {
            reason.current = null;
            setAutoIncluded(null);
            setPreview(null);
          }}
          onConfirm={() => {
            close.mutate();
          }}
        />
      )}

      <div
        data-slot="sticky-action-bar"
        className="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t bg-background px-4 py-3"
      >
        <span className="mr-auto grid gap-0.5">
          <CloseHint view={progress} />
          <span className="text-xs text-muted-foreground">
            Lo escrito se guarda en este navegador hasta registrarlo.
          </span>
        </span>
        <OperationDateField value={operationDate} onChange={onOperationDate} />
        <Button
          variant={progress.canClose ? 'outline' : 'default'}
          aria-label={`Registrar producción de ${order.code}`}
          pending={sending && !closing.current}
          pendingText="Registrando…"
          disabled={busy || registrable.every((b) => b.check.meters === null)}
          onClick={() => {
            start(false);
          }}
        >
          Registrar producción
        </Button>
        <CloseButton
          view={progress}
          code={order.code}
          pending={previewClose.isPending}
          busy={busy}
          onClick={() => {
            start(true);
          }}
        />
      </div>

      <ReasonDialog
        open={askingReason}
        onOpenChange={(open) => {
          if (!open) reason.current = null;
          setAskingReason(open);
        }}
        title="Cerrar con despunte alto"
        description={`El despunte pasa del ${String(MAX_SCRAP_RATIO_WITHOUT_REASON * 100)} % de lo consumido y sale del inventario. Si el material sigue entero en el almacén, vuelve y declara menos kilos consumidos. Si de verdad salió como despunte, explica por qué.`}
        confirmLabel="Seguir con el cierre"
        pending={busy}
        onConfirm={(value: string) => {
          reason.current = value;
          setAskingReason(false);
          previewClose.mutate();
        }}
      />

      <BackdateConfirmDialog
        open={run.open}
        onOpenChange={(open) => {
          if (!open) run.close();
        }}
        detail={run.detail ?? ''}
        pending={busy}
        onConfirm={() => {
          void run.confirm();
        }}
      />
    </div>
  );
}
