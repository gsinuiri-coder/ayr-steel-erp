'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Decimal,
  MAX_SCRAP_RATIO_WITHOUT_REASON,
  sum,
  toDecimal,
  type ProductionOrderDto,
  type RoofingBatchOrderDto,
  type RoofingReportDraftDto,
} from '@ayr/shared';
import {
  accessoryBlock,
  accessoryFill,
  EMPTY_ACCESSORY_EDIT,
  typedMeters,
  type AccessoryEdit,
} from '@/lib/accessory-blocks';
import {
  accessoryDraftContent,
  accessoryEditFromDrafts,
  accessoryEditMeters,
  hasLegacyAccessoryEdits,
  uploadLegacyAccessoryEdits,
} from '@/lib/accessory-drafts';
import { api } from '@/lib/api';
import { formatKg, formatMeters, formatQtyAsIs } from '@/lib/format';
import { planProgress } from '@/lib/plan-progress';
import { errorMessage, toast } from '@/lib/notify';

import { cn } from '@/lib/utils';
import { BackdateConfirmDialog } from '@/components/backdate-confirm-dialog';
import { OperationDateField } from '@/components/operation-date-field';
import { ReasonDialog } from '@/components/reason-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AutoConfirmBlock, BandHeader, ClosePreviewBlock, Stat } from './produce-blocks';
import { CloseButton, CloseHint, CoilStatusBadge, PlanProgressBar } from './plan-progress-view';
import { useBlockDrafts, type DraftAdapter } from './use-block-drafts';
import {
  DraftSaveStatus,
  useDraftCommit,
  useDraftsCache,
  type DraftToleranceOverride,
} from './use-draft-commit';
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
 * cc41 (D-591, reemplaza D-559): lo escrito se guarda **en el borrador de la orden** (D-191), como
 * en coberturas (`useBlockDrafts` con los metros de bobina): sobrevive a un refresco y se ve desde
 * otro equipo. «Registrar producción» ejecuta el borrador entero en una transacción (todo o nada)
 * y «Registrar y cerrar» lo ejecuta y cierra en la misma, con «Qué va a pasar» de su vista previa.
 * Lo que D-559 dejó en el navegador sube una vez al borrador al abrir la orden
 * (`uploadLegacyAccessoryEdits`).
 */

const ACCESSORY_DRAFTS: DraftAdapter<AccessoryEdit> = {
  content: accessoryDraftContent,
  meters: accessoryEditMeters,
};

/** El almacenamiento del navegador, si se puede leer (ventana privada o bloqueado: no). */
function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
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
  const onSaved = useDraftsCache(order.orderId);
  const drafts = useBlockDrafts(order, onSaved, ACCESSORY_DRAFTS);
  /** Último bloque vaciado a mano: no se vuelve a llenar solo hasta que se escriba en él. */
  const [emptied, setEmptied] = useState<ReadonlySet<string>>(new Set());
  /** Guardando lo pendiente antes de registrar: los botones no aceptan otro clic. */
  const [starting, setStarting] = useState(false);

  const [overrides, setOverrides] = useState<Record<string, ToleranceOverrideState>>({});
  const [attempted, setAttempted] = useState(false);
  /** Las casillas listas por fila del borrador; se calculan más abajo, con los bloques. */
  const overridesRef = useRef<() => DraftToleranceOverride[]>(() => []);
  const {
    commit,
    previewClose,
    run,
    preview,
    setPreview,
    commitError,
    setCommitError,
    askingReason,
    setAskingReason,
    reason,
    closing,
  } = useDraftCommit({
    order,
    operationDate,
    latestDrafts: drafts.latestDrafts,
    toleranceOverrides: () => overridesRef.current(),
    onUpdated,
    onCommitted: () => {
      setOverrides({});
      setAttempted(false);
    },
  });

  // cc41: lo que D-559 dejó en este navegador sube una vez al borrador del servidor (si el
  // servidor ya tiene borrador, gana el servidor) y la clave local se borra. Sin avisos salvo error.
  const migrated = useRef<string | null>(null);
  useEffect(() => {
    if (migrated.current === order.orderId) return;
    migrated.current = order.orderId;
    const storage = browserStorage();
    if (!hasLegacyAccessoryEdits(storage, order.orderId)) return;
    const codeOf = (coilId: string) => order.coils.find((c) => c.coilId === coilId)?.coilCode ?? '';
    // Con algo del navegador por subir, el borrador se lee recién del servidor: la caché puede
    // ser vieja, y decidir con ella podía dar de alta una segunda fila para la misma bobina.
    void api<RoofingReportDraftDto[]>(`/production/roofing/${order.orderId}/drafts`)
      .then((fresh) => {
        onSaved(fresh);
        return uploadLegacyAccessoryEdits({
          storage,
          orderId: order.orderId,
          coilIds: order.coils.map((c) => c.coilId),
          serverCoilIds: fresh.map((d) => d.coilId),
          registeredCoilIds: order.coils
            .filter((c) => toDecimal(c.reportedMeters).gt(0))
            .map((c) => c.coilId),
          // Si el operario ya escribió en ese bloque mientras subía lo anterior, gana lo suyo.
          save: (coilId, edit) =>
            drafts.touched(coilId) ? Promise.resolve(true) : drafts.put(coilId, edit),
        });
      })
      .then(({ failed, doubtful }) => {
        if (failed !== null) {
          toast.error(
            `No se pudo pasar al borrador lo escrito en este navegador para la bobina ${codeOf(failed)}: corrígelo en su bloque.`,
          );
        }
        if (doubtful.length > 0) {
          toast.error(
            `Lo escrito en este navegador para ${doubtful.map(codeOf).join(', ')} quizá ya se registró: revisa lo registrado y escribe lo que falte.`,
          );
        }
      })
      .catch((err: unknown) => {
        toast.error(errorMessage(err, 'No se pudo leer el borrador de la orden'));
      });
    // Una vez por orden: lo que se lee es el estado con el que se abrió.
  }, [order.orderId]);

  const coils = order.coils;
  const blocks = useMemo(() => {
    const lastCoil = coils[coils.length - 1];
    const contentOf = (coilId: string): AccessoryEdit | null =>
      drafts.edits[coilId] ??
      accessoryEditFromDrafts(order.drafts.filter((d) => d.coilId === coilId));
    const others = coils
      .filter((c) => c.coilId !== lastCoil?.coilId)
      .map((c) => typedMeters(contentOf(c.coilId)?.meters ?? ''));
    return coils.map((coil, i) => {
      const last = coil.coilId === lastCoil?.coilId;
      const content = contentOf(coil.coilId);
      const derived = last && content === null && !emptied.has(coil.coilId);
      const fill = derived ? accessoryFill(order.remainingMeters, others) : null;
      const shown: AccessoryEdit = derived
        ? { ...EMPTY_ACCESSORY_EDIT, meters: fill?.gt(0) ? fill.toFixed(3) : '' }
        : (content ?? EMPTY_ACCESSORY_EDIT);
      return { coil, index: i + 1, last, derived, edit: shown, check: accessoryBlock(coil, shown) };
    });
  }, [coils, order.drafts, order.remainingMeters, drafts.edits, emptied]);
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

  /**
   * Escribir en un bloque lo deja confirmado (D-575) y lo guarda en el borrador. El último, vaciado
   * del todo, no se vuelve a llenar solo hasta que se escriba en él.
   */
  const editBlock = (b: (typeof blocks)[number], next: AccessoryEdit) => {
    setCommitError(null);
    if (b.last) {
      const content = accessoryDraftContent(next);
      setEmptied((prev) => {
        const out = new Set(prev);
        if (content.ok && content.content === null) out.add(b.coil.coilId);
        else out.delete(b.coil.coilId);
        return out;
      });
    }
    drafts.edit(b.coil.coilId, next);
  };

  /** «Sí, salió así»: lo llenado pasa al borrador tal como se ve (D-575). */
  const confirmAuto = async (): Promise<boolean> => {
    if (autoBlock === undefined) return true;
    drafts.edit(autoBlock.coil.coilId, autoBlock.edit, { immediate: true });
    return drafts.flush([autoBlock.coil.coilId]);
  };

  /** «Vaciar»: el bloque llenado solo queda vacío y no se vuelve a llenar hasta escribir en él. */
  const clearAuto = () => {
    if (autoBlock === undefined) return;
    setEmptied((prev) => new Set(prev).add(autoBlock.coil.coilId));
  };

  // ---------------------------------------------------------------------------
  // Registrar: el borrador entero, en una transacción (D-191)
  // ---------------------------------------------------------------------------

  const excessBlocks = registrable.filter(
    (b) => b.check.figures.excess !== null && b.check.meters !== null,
  );
  const pendingOverride = excessBlocks.find(
    (b) => overrideInput(overrides[b.coil.coilId], b.check.figures.excess) === null,
  );
  const blocking = registrable.find(
    (b) => b.check.error !== null || (drafts.states[b.coil.coilId]?.error ?? null) !== null,
  );
  const hasContent = registrable.some((b) => b.check.meters !== null) || order.drafts.length > 0;

  /** Guarda lo pendiente de los bloques confirmados (el llenado solo se queda en la pantalla). */
  const persistAll = (): Promise<boolean> => drafts.flush(registrable.map((b) => b.coil.coilId));

  overridesRef.current = () => {
    const byCoil = new Map(drafts.latestDrafts().map((d) => [d.coilId, d.id]));
    return excessBlocks.flatMap((b) => {
      const input = overrideInput(overrides[b.coil.coilId], b.check.figures.excess);
      const draftId = byCoil.get(b.coil.coilId);
      return input === null || draftId === undefined ? [] : [{ draftId, ...input }];
    });
  };

  const start = async (shouldClose: boolean) => {
    setAttempted(true);
    setCommitError(null);
    closing.current = shouldClose;
    reason.current = null;
    if (blocking !== undefined || pendingOverride !== undefined) return;
    if (!shouldClose && !hasContent) {
      toast.warning('No hay nada escrito para registrar.');
      return;
    }
    // D-573: con los metros de la orden incompletos no se cierra (el API tampoco deja).
    if (shouldClose && !progress.canClose) return;
    setStarting(true);
    try {
      if (!(await persistAll())) return;
    } finally {
      setStarting(false);
    }
    // D-575: «Qué va a pasar» pide confirmar el bloque llenado solo antes de calcular.
    if (shouldClose && autoBlock !== undefined && autoBlock.check.figures.excess !== null) {
      toast.warning(
        'El bloque llenado solo pasa lo montado: confírmalo con «Sí, salió así» y marca la tolerancia.',
      );
      return;
    }
    if (shouldClose && autoBlock !== undefined) {
      setAskingAuto(autoLabel(autoBlock));
      return;
    }
    void run.attempt();
  };

  /** La casilla «Confirmo que salieron»: confirma el bloque y calcula «Qué va a pasar». */
  const confirmAutoAndPreview = async () => {
    const label = askingAuto;
    setStarting(true);
    try {
      if (!(await confirmAuto())) {
        setAskingAuto(null);
        return;
      }
    } finally {
      setStarting(false);
    }
    setAskingAuto(null);
    setAutoIncluded(label);
    void run.attempt();
  };

  // Con «Qué va a pasar» a la vista no se edita: se confirma lo que el resumen dijo.
  const busy =
    starting ||
    commit.isPending ||
    previewClose.isPending ||
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
              const error =
                (commitError !== null && commitError.coilId === b.coil.coilId
                  ? commitError.message
                  : null) ??
                drafts.states[b.coil.coilId]?.error ??
                b.check.error;
              const override = overrides[b.coil.coilId] ?? EMPTY_OVERRIDE;
              const auto = b === autoBlock;
              return (
                <div
                  key={b.coil.coilId}
                  data-testid={`bloque-${b.coil.coilCode}`}
                  data-auto={auto ? 'sin-confirmar' : undefined}
                  onBlur={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget)) drafts.flushOne(b.coil.coilId);
                  }}
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
                          onClick={() => {
                            void confirmAuto();
                          }}
                        >
                          Sí, salió así
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Vaciar ${label}`}
                          disabled={busy}
                          onClick={() => {
                            clearAuto();
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
                            editBlock(b, { ...b.edit, meters: e.target.value });
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
                          editBlock(b, { ...b.edit, pieces: e.target.value });
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
                          editBlock(b, { ...b.edit, consumedKg: e.target.value });
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
          pending={starting}
          onConfirm={() => {
            void confirmAutoAndPreview();
          }}
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
          pending={commit.isPending}
          onBack={() => {
            reason.current = null;
            setAutoIncluded(null);
            setPreview(null);
          }}
          onConfirm={() => {
            commit.mutate(true);
          }}
        />
      )}

      <div
        data-slot="sticky-action-bar"
        className="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t bg-background px-4 py-3"
      >
        <span className="mr-auto grid gap-0.5">
          <CloseHint view={progress} />
          <DraftSaveStatus states={drafts.states} edits={drafts.edits} />
        </span>
        <OperationDateField value={operationDate} onChange={onOperationDate} />
        <Button
          variant={progress.canClose ? 'outline' : 'default'}
          aria-label={`Registrar producción de ${order.code}`}
          pending={commit.isPending && !closing.current}
          pendingText="Registrando…"
          disabled={busy || !hasContent}
          onClick={() => {
            void start(false);
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
            void start(true);
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
