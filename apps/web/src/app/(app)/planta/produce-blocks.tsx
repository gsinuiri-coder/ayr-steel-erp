'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Decimal,
  MAX_SCRAP_RATIO_WITHOUT_REASON,
  piecesCount,
  piecesTheoreticalKg,
  sum,
  TOLERANCE_OVERRIDE_REQUIRED,
  toDecimal,
  Unit,
  type PlantClosePreviewDto,
  type ProductionOrderDto,
  type RoofingBatchCoilDto,
  type RoofingBatchOrderDto,
  type RoofingPieceDto,
  type RoofingReportDraftDto,
  BACKDATE_OUT_OF_ORDER,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatKg, formatMeters, formatQtyAsIs } from '@/lib/format';
import { errorMessage, toast } from '@/lib/notify';
import type { PieceRow } from '@/lib/pieces';
import {
  blockFigures,
  byLength,
  catalogRows,
  coilOfRowError,
  editRow,
  fillFromRemaining,
  planSquare,
  withoutRowPrefix,
  type BlockFigures,
} from '@/lib/production-blocks';
import { invalidateProduction } from '@/lib/production-queries';
import { useBackdateConfirm } from '@/lib/use-backdate-confirm';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { cn } from '@/lib/utils';
import { BackdateConfirmDialog } from '@/components/backdate-confirm-dialog';
import { OperationDateField } from '@/components/operation-date-field';
import { ReasonDialog } from '@/components/reason-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { PlanAdjustDialog } from './plan-adjust-dialog';
import {
  EMPTY_OVERRIDE,
  overrideInput,
  ToleranceOverrideRow,
  type ToleranceOverrideState,
} from './tolerance-override';
import { blockPayload, type BlockEdit } from '@/lib/block-drafts';
import { planProgress } from '@/lib/plan-progress';
import { useBlockDrafts } from './use-block-drafts';
import {
  CloseButton,
  CloseHint,
  CoilStatusBadge,
  cutsLabel,
  lengthLabel,
  PlanProgressBar,
} from './plan-progress-view';

/**
 * cc35 (ESPEC §1 y §2) — **producir una OP con el modelo M**: bobina por bobina, en el orden en que
 * se montaron. Reemplaza las tarjetas «Plan de corte», «Bobina montada» y «Reportar lo que salió»
 * de una cobertura a medida o una plancha de catálogo (el accesorio y drywall no cambian acá).
 *
 * - Un **bloque por bobina** montada, en orden de montaje: sus cortes (largo × planchas), metros y
 *   kilos teóricos, kg consumidos (opcional: vacío vale el teórico), despunte y lo que queda, y si
 *   la bobina «se terminó» o «sigue montada».
 * - **El último bloque se llena solo con lo que falta del plan**; los anteriores los escribe el
 *   supervisor. Las bobinas terminadas se pliegan a una línea («Abrir ▸» para corregir).
 * - Lo escrito se guarda solo en el borrador de la orden (`useBlockDrafts`, D-191).
 * - «Registrar producción» es el commit del borrador (todo o nada, revalidado). Un error «Fila N»
 *   se muestra en el bloque de esa bobina. «Registrar y cerrar» muestra antes «Qué va a pasar»,
 *   calculado por el API sin escribir nada (D-453), con el despunte por bobina (cc34).
 * - Los kg de cada bloque viajan como `consumedKg` de su fila: el cierre saca el despunte de cada
 *   bobina con sus propios partes (cc34, D-539). El campo único «kg que consumió la bobina» ya no
 *   está en pantalla (el API lo sigue aceptando).
 */

interface Block {
  coil: RoofingBatchCoilDto;
  /** Número de la bobina en el orden de montaje (1..N). */
  index: number;
  last: boolean;
  /** Las filas a la vista (edición en curso, borrador guardado o relleno del último). */
  rows: PieceRow[];
  consumedKg: string;
  /** El último bloque sin nada escrito ni guardado: se llenó solo con lo que falta. */
  derived: boolean;
  pieces: RoofingPieceDto[];
  figures: BlockFigures;
  /** El bloque no se puede guardar así (cortes mal escritos). */
  parseError: string | null;
}

const EMPTY_ROW: PieceRow = { lengthM: '', qty: '' };

function rowsOf(pieces: readonly { lengthMm: string; qty: number }[]): PieceRow[] {
  return pieces.map((p) => ({ lengthM: lengthLabel(p.lengthMm), qty: String(p.qty) }));
}

/** Los metros de un corte escrito, o vacío si todavía no se puede contar. */
function rowMeters(lengthM: string, qty: string): string {
  if (!/^\d+(\.\d{1,3})?$/.test(lengthM.trim()) || !/^\d+$/.test(qty.trim())) return '';
  return `${toDecimal(lengthM.trim()).times(qty.trim()).toFixed(3)} m`;
}

/** Siempre queda un renglón vacío al final para el corte siguiente. */
/** «16 planchas que se llenaron solas en la bobina XSY-…» (D-575, «Qué va a pasar»). */
function autoLabel(block: Block): string {
  const count = block.pieces.reduce((acc, p) => acc + p.qty, 0);
  return `${String(count)} ${count === 1 ? 'plancha que se llenó sola' : 'planchas que se llenaron solas'} en la bobina ${block.coil.coilCode}`;
}

function withTrailingRow(rows: PieceRow[]): PieceRow[] {
  const last = rows[rows.length - 1];
  if (last?.lengthM.trim() !== '' || last.qty.trim() !== '') {
    return [...rows, EMPTY_ROW];
  }
  return rows;
}

export function ProduceBlocks({
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
  /** Tras registrar: los avisos del agregado que devolvió el API (D-154). */
  onUpdated: (updated: ProductionOrderDto | null) => void;
  /** El botón «Montar bobinas» (el modal de cc35, corte 2). */
  mountButton: React.ReactNode;
  /** Bajar una bobina montada por error que todavía no roló. */
  releaseCoil: (consumptionId: string) => void;
  releasing: boolean;
}) {
  const queryClient = useQueryClient();
  const invalidate = useCallback(() => {
    invalidateProduction(queryClient, order.orderId);
  }, [queryClient, order.orderId]);
  /**
   * Guardar un bloque no toca el kardex: la pantalla toma el borrador que devolvió el API en su
   * caché, sin volver a pedir todas las órdenes (revisión de cc35: cada pausa refrescaba todo).
   */
  const onSaved = useCallback(
    (list: RoofingReportDraftDto[]) => {
      queryClient.setQueriesData<RoofingBatchOrderDto[]>({ queryKey: ['roofing-batch'] }, (old) =>
        old?.map((o) =>
          o.orderId === order.orderId
            ? {
                ...o,
                drafts: list,
                draftMeters: sum(list.map((d) => toDecimal(d.meters))).toFixed(3),
              }
            : o,
        ),
      );
    },
    [queryClient, order.orderId],
  );
  const drafts = useBlockDrafts(order, onSaved);
  /** Último bloque vaciado a mano: no se vuelve a llenar solo hasta que se escriba en él. */
  const [emptied, setEmptied] = useState<ReadonlySet<string>>(new Set());
  /** Guardando lo pendiente antes de registrar: los botones no aceptan otro clic. */
  const [starting, setStarting] = useState(false);
  const catalog = order.productUnit !== Unit.MTR && order.productLengthMm !== null;

  const [overrides, setOverrides] = useState<Record<string, ToleranceOverrideState>>({});
  /** Bloques plegados (`false`) o abiertos (`true`) a mano; sin entrada, decide su estado. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** El error del último registro, en el bloque de su bobina (o arriba si no nombra una fila). */
  const [commitError, setCommitError] = useState<{ coilId: string | null; message: string } | null>(
    null,
  );
  const [attempted, setAttempted] = useState(false);
  const [preview, setPreview] = useState<PlantClosePreviewDto | null>(null);
  const [askingReason, setAskingReason] = useState(false);
  /** D-575: «Qué va a pasar» esperando que se confirme el bloque llenado solo (su descripción). */
  const [askingAuto, setAskingAuto] = useState<string | null>(null);
  /** El bloque llenado solo que se confirmó desde «Qué va a pasar» (para nombrarlo ahí). */
  const [autoIncluded, setAutoIncluded] = useState<string | null>(null);
  const [planOpen, setPlanOpen] = useState<{ addLengthM?: string } | null>(null);
  const reason = useRef<string | null>(null);
  const closing = useRef(false);
  const backdate = useRef(false);

  // ---------------------------------------------------------------------------
  // Los bloques
  // ---------------------------------------------------------------------------

  const blocks: Block[] = useMemo(() => {
    const coils = order.coils;
    const lastCoil = coils[coils.length - 1];
    const saved = (coilId: string) => order.drafts.filter((d) => d.coilId === coilId);
    const contentOf = (coilId: string): { rows: PieceRow[]; consumedKg: string } | null => {
      const edit = drafts.edits[coilId];
      if (edit !== undefined) return edit;
      const rows = saved(coilId);
      if (rows.length === 0) return null;
      const kg = rows.reduce(
        (acc, d) => (d.consumedKg === null ? acc : acc.plus(d.consumedKg)),
        new Decimal(0),
      );
      return {
        // Un borrador viejo con dos filas de la misma bobina se suma por largo (D-548).
        rows: rowsOf(
          [...byLength(rows.flatMap((d) => d.pieces))].map(([lengthMm, qty]) => ({
            lengthMm,
            qty,
          })),
        ),
        consumedKg: rows.some((d) => d.consumedKg !== null) ? kg.toFixed(3) : '',
      };
    };
    const piecesOf = (content: { rows: PieceRow[]; consumedKg: string } | null) => {
      if (content === null) return [];
      const payload = blockPayload(content);
      return payload.ok ? payload.pieces : [];
    };
    const others = coils
      .filter((c) => c.coilId !== lastCoil?.coilId)
      .map((c) => piecesOf(contentOf(c.coilId)));
    return coils.map((coil, i) => {
      const last = i === coils.length - 1;
      const content = contentOf(coil.coilId);
      const derived = last && content === null && !emptied.has(coil.coilId);
      const rows = derived
        ? rowsOf(fillFromRemaining(order.remainingPieces, others))
        : (content?.rows ?? []);
      const consumedKg = content?.consumedKg ?? '';
      const payload = blockPayload({ rows, consumedKg });
      const pieces = payload.ok ? payload.pieces : [];
      return {
        coil,
        index: i + 1,
        last,
        rows: catalog ? catalogRows(rows) : withTrailingRow(rows),
        consumedKg,
        derived,
        pieces,
        figures: blockFigures(coil, pieces, payload.ok ? consumedKg : ''),
        parseError: payload.ok ? null : payload.reason,
      };
    });
  }, [order.coils, order.drafts, order.remainingPieces, drafts.edits, catalog, emptied]);

  /** D-575: el bloque llenado solo y sin confirmar no viaja en ningún commit. */
  const autoBlock = blocks.find((b) => b.derived && b.pieces.length > 0);

  /**
   * Escribir en un bloque lo deja confirmado (D-575): si es el último, deja de llenarse solo. El
   * último sin confirmar se vuelve a llenar con lo que falta cada vez que cambia otro bloque; uno
   * ya confirmado no se toca (lo escribió o lo confirmó el supervisor), y si con el cambio el
   * borrador pasa el plan, el API lo rechaza en el bloque que se está escribiendo (D-574).
   */
  const editBlock = (block: Block, next: BlockEdit) => {
    setCommitError(null);
    setExpanded((prev) => ({ ...prev, [block.coil.coilId]: true }));
    if (block.last) {
      const payload = blockPayload(next);
      setEmptied((prev) => {
        const out = new Set(prev);
        if (payload.ok && payload.empty) out.add(block.coil.coilId);
        else out.delete(block.coil.coilId);
        return out;
      });
    }
    drafts.edit(block.coil.coilId, next);
  };

  /** «Sí, salió así»: el bloque llenado solo pasa al borrador tal como se ve (D-575). */
  const confirmAuto = async (): Promise<boolean> => {
    if (autoBlock === undefined) return true;
    drafts.edit(
      autoBlock.coil.coilId,
      {
        rows: autoBlock.rows.filter((r) => r.lengthM.trim() !== '' || r.qty.trim() !== ''),
        consumedKg: autoBlock.consumedKg,
      },
      { immediate: true },
    );
    return drafts.flush([autoBlock.coil.coilId]);
  };

  /** «Vaciar»: el bloque llenado solo queda vacío y no se vuelve a llenar hasta escribir en él. */
  const clearAuto = () => {
    if (autoBlock === undefined) return;
    setEmptied((prev) => new Set(prev).add(autoBlock.coil.coilId));
  };

  // ---------------------------------------------------------------------------
  // Registrar
  // ---------------------------------------------------------------------------

  const registrable = blocks.filter((b) => !b.derived);
  const excessBlocks = registrable.filter((b) => b.figures.excess !== null && b.pieces.length > 0);
  const overridesReady = excessBlocks.every(
    (b) => overrideInput(overrides[b.coil.coilId], b.figures.excess) !== null,
  );
  const blocking = registrable.find((b) => b.parseError !== null || b.figures.error !== null);
  const hasContent = registrable.some((b) => b.pieces.length > 0) || order.drafts.length > 0;
  const progress = planProgress({
    planMeters: order.planMeters,
    reportedMeters: order.reportedMeters,
    plan: {
      items: order.planItems,
      remainingPieces: order.remainingPieces,
      reportedPieces: order.reportedPieces,
    },
    draft: registrable.flatMap((b) => b.pieces),
    auto: autoBlock?.pieces ?? [],
  });

  /** Guarda lo pendiente de los bloques confirmados (el llenado solo se queda en la pantalla). */
  const persistAll = (): Promise<boolean> => drafts.flush(registrable.map((b) => b.coil.coilId));

  const submitKey = useIdempotencyKey();
  const body = (close: boolean) => {
    const byCoil = new Map(drafts.latestDrafts().map((d) => [d.coilId, d.id]));
    const toleranceOverrides = excessBlocks.flatMap((b) => {
      const input = overrideInput(overrides[b.coil.coilId], b.figures.excess);
      const draftId = byCoil.get(b.coil.coilId);
      return input === null || draftId === undefined ? [] : [{ draftId, ...input }];
    });
    return {
      ...(close ? { close: true } : {}),
      ...(close && reason.current ? { closeReason: reason.current } : {}),
      ...(toleranceOverrides.length > 0 ? { toleranceOverrides } : {}),
      operationDate,
      confirmBackdate: backdate.current || undefined,
      // D-182: la clave va atada a lo que se registra, no solo a si cierra.
      idempotencyKey: submitKey.current(
        JSON.stringify({
          close,
          rows: drafts.latestDrafts().map((d) => [d.id, d.meters, d.consumedKg]),
          toleranceOverrides,
        }),
      ),
    };
  };

  /** Un rechazo del registro: en el bloque de su fila, o arriba. */
  const onError = (err: unknown) => {
    // D-124: la retro-fecha la atiende su diálogo (`useBackdateConfirm`), no es un error del bloque.
    if (err instanceof ApiError && err.code === BACKDATE_OUT_OF_ORDER) return;
    setPreview(null);
    const message = errorMessage(err, 'No se pudo registrar la producción');
    if (err instanceof ApiError && /motivo/i.test(err.message) && closing.current) {
      if (err.code !== TOLERANCE_OVERRIDE_REQUIRED) {
        setAskingReason(true);
        return;
      }
    }
    reason.current = null;
    const coilId = coilOfRowError(message, drafts.latestDrafts());
    setCommitError({ coilId, message: coilId === null ? message : withoutRowPrefix(message) });
    if (coilId !== null) setExpanded((prev) => ({ ...prev, [coilId]: true }));
    toast.error(message);
    invalidate();
  };

  const commit = useMutation({
    mutationFn: (close: boolean) =>
      api<ProductionOrderDto>(`/production/roofing/${order.orderId}/drafts/commit`, {
        method: 'POST',
        body: body(close),
      }),
    onSettled: (_d, error) => {
      submitKey.settle(error ?? undefined);
    },
    onSuccess: (updated, close) => {
      toast.success(
        close
          ? `${order.code}: producción registrada y orden cerrada`
          : `${order.code}: producción registrada`,
      );
      setOverrides({});
      setPreview(null);
      setCommitError(null);
      setAttempted(false);
      reason.current = null;
      onUpdated(updated);
      invalidate();
    },
    onError,
  });

  const previewClose = useMutation({
    mutationFn: () =>
      api<PlantClosePreviewDto>(`/production/roofing/${order.orderId}/drafts/commit/preview`, {
        method: 'POST',
        body: body(true),
      }),
    onSuccess: (result) => {
      setPreview(result);
    },
    onError,
  });

  const run = useBackdateConfirm(async (confirmBackdate) => {
    backdate.current = confirmBackdate;
    if (closing.current) await previewClose.mutateAsync();
    else await commit.mutateAsync(false);
  });

  const start = async (close: boolean) => {
    setAttempted(true);
    setCommitError(null);
    closing.current = close;
    if (blocking !== undefined || !overridesReady) {
      const target =
        blocking ??
        excessBlocks.find(
          (b) => overrideInput(overrides[b.coil.coilId], b.figures.excess) === null,
        );
      if (target) {
        setExpanded((prev) => ({ ...prev, [target.coil.coilId]: true }));
        document
          .getElementById(`bloque-${target.coil.coilId}`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      return;
    }
    if (!close && !hasContent) {
      toast.warning('No hay nada escrito para registrar.');
      return;
    }
    // D-573: la pantalla no deja cerrar con el plan incompleto (el API tampoco).
    if (close && !progress.canClose) return;
    setStarting(true);
    try {
      if (!(await persistAll())) return;
    } finally {
      setStarting(false);
    }
    // D-575: con un bloque llenado solo, «Qué va a pasar» pide confirmarlo antes de calcular.
    // Si pasa lo montado más del 1 %, se confirma en el bloque: ahí va la casilla de tolerancia.
    if (close && autoBlock !== undefined && autoBlock.figures.excess !== null) {
      toast.warning(
        'El bloque llenado solo pasa lo montado: confírmalo con «Sí, salió así» y marca la tolerancia.',
      );
      document
        .getElementById(`bloque-${autoBlock.coil.coilId}`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (close && autoBlock !== undefined) {
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

  /**
   * Los campos solo se apagan mientras se registra o con «Qué va a pasar» a la vista (lo que se
   * confirma es lo que el resumen dijo). Un refresco de la lista no los apaga: se perdían teclas.
   */
  const locked =
    commit.isPending ||
    previewClose.isPending ||
    preview !== null ||
    askingAuto !== null ||
    releasing;
  const busy = locked || starting || refreshing;

  // ---------------------------------------------------------------------------
  // Pantalla
  // ---------------------------------------------------------------------------

  const square = planSquare(
    order.planItems,
    order.remainingPieces,
    blocks.map((b) => b.pieces),
  );
  const scrapTotal = sum(blocks.map((b) => b.figures.scrapKg));
  const consumedTotal = sum(blocks.map((b) => b.figures.outKg.plus(b.figures.scrapKg)));
  const planKg =
    order.coils[0] === undefined ? null : piecesTheoreticalKg(order.coils[0], order.planItems);
  const folded = (b: Block) =>
    blocks.length > 1 && !b.last && b.figures.terminated && expanded[b.coil.coilId] !== true;
  const foldedBlocks = blocks.filter(folded);
  const openBlocks = blocks.filter((b) => !folded(b));

  return (
    <div className="grid gap-4">
      <section className="grid gap-2" aria-label={`Plan y avance de ${order.code}`}>
        <BandHeader title="Plan y avance">
          <Button
            variant="outline"
            size="sm"
            aria-label={`Ajustar el plan de corte de ${order.code}`}
            onClick={() => {
              setPlanOpen({});
            }}
          >
            Ajustar el plan
          </Button>
        </BandHeader>
        <div className="grid gap-2.5 px-1">
          <div className="flex flex-wrap gap-x-8 gap-y-2 rounded-lg bg-muted/60 px-4 py-2.5">
            <Stat
              label="Plan"
              value={
                catalog
                  ? `Plancha ${lengthLabel(order.productLengthMm ?? '0')} m · ${String(piecesCount(order.planItems))} und`
                  : `${String(order.planItems.length)} ${order.planItems.length === 1 ? 'largo' : 'largos'} · ${String(piecesCount(order.planItems))} planchas`
              }
            />
            <Stat label="Metros del plan" value={formatMeters(order.planMeters)} />
            <Stat label="Teórico del plan" value={planKg === null ? '—' : formatKg(planKg)} />
          </div>
          <PlanProgressBar
            view={progress}
            unitWord={catalog ? 'und' : 'planchas'}
            label={`Avance de ${order.code}`}
          />
        </div>
      </section>

      {catalog && (
        <p className="text-xs text-muted-foreground">
          Una plancha de catálogo tiene un solo largo: cada bobina lleva una sola fila, con
          unidades.
        </p>
      )}

      <section className="grid gap-2" aria-label={`Bobinas de ${order.code}`}>
        <BandHeader title={`Bobinas · ${String(blocks.length)}`}>{mountButton}</BandHeader>
        {blocks.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">
            La orden no tiene ninguna bobina montada: monta una y lo que falta del plan aparece acá,
            listo para ajustar.
          </p>
        ) : (
          <div className="grid gap-3 px-1">
            {foldedBlocks.length > 0 && (
              <div className="divide-y rounded-lg border" aria-label="Bobinas terminadas">
                {foldedBlocks.map((b) => {
                  const inDraft = !b.derived && b.pieces.length > 0;
                  const shown = inDraft ? b.pieces : b.coil.reportedPieces;
                  return (
                    <div
                      key={b.coil.coilId}
                      className="grid grid-cols-[1.5rem_auto_minmax(0,1fr)_auto_auto_auto] items-center gap-3.5 px-3 py-2 text-sm tabular-nums"
                      data-testid={`bloque-plegado-${b.coil.coilCode}`}
                    >
                      <span className="text-muted-foreground">{b.index}</span>
                      <span className="font-mono text-xs">{b.coil.coilCode}</span>
                      <span className="truncate">{cutsLabel(shown) || '—'}</span>
                      <span className="text-right">
                        {formatMeters(inDraft ? b.figures.meters : b.coil.reportedMeters)}
                      </span>
                      <CoilStatusBadge
                        inDraft={inDraft}
                        registered={toDecimal(b.coil.reportedMeters).gt(0)}
                      />
                      <Button
                        variant="link"
                        size="sm"
                        aria-label={`Abrir la bobina ${b.coil.coilCode}`}
                        onClick={() => {
                          setExpanded((prev) => ({ ...prev, [b.coil.coilId]: true }));
                        }}
                      >
                        Abrir ▸
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
            {openBlocks.length > 0 && (
              <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                {openBlocks.map((b) => (
                  <BlockCard
                    key={b.coil.coilId}
                    block={b}
                    order={order}
                    catalog={catalog}
                    busy={locked}
                    attempted={attempted}
                    saveState={drafts.states[b.coil.coilId]}
                    commitError={commitError?.coilId === b.coil.coilId ? commitError.message : null}
                    override={overrides[b.coil.coilId] ?? EMPTY_OVERRIDE}
                    onOverride={(next) => {
                      setOverrides((prev) => ({ ...prev, [b.coil.coilId]: next }));
                    }}
                    onEdit={(next) => {
                      editBlock(b, next);
                    }}
                    onBlur={() => {
                      drafts.flushOne(b.coil.coilId);
                    }}
                    onOtherLength={() => {
                      setPlanOpen({ addLengthM: '' });
                    }}
                    onConfirmAuto={
                      b === autoBlock
                        ? () => {
                            void confirmAuto();
                          }
                        : undefined
                    }
                    onClearAuto={b === autoBlock ? clearAuto : undefined}
                    onFold={
                      blocks.length > 1 && !b.last && b.figures.terminated
                        ? () => {
                            setExpanded((prev) => ({ ...prev, [b.coil.coilId]: false }));
                          }
                        : undefined
                    }
                    onRelease={
                      toDecimal(b.coil.consumedKg).isZero() &&
                      !order.drafts.some((d) => d.coilId === b.coil.coilId)
                        ? () => {
                            releaseCoil(b.coil.consumptionId);
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              El borrador se guarda solo y se puede registrar por partes con «Registrar producción».
              Lo registrado ya no se edita desde aquí.
            </p>
          </div>
        )}
      </section>

      {blocks.length > 0 && order.planItems.length > 0 && (
        <div
          role="status"
          data-testid="cuadre-plan"
          className={cn(
            'flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm',
            square.complete
              ? 'border-tone-done-foreground/30 bg-tone-done text-tone-done-foreground'
              : 'bg-muted/40',
          )}
        >
          <span>
            {blocks.length === 1 ? '1 bobina' : `${String(blocks.length)} bobinas`} ={' '}
            <span className="font-semibold tabular-nums">
              {square.covered} de {square.planned} {catalog ? 'und' : 'planchas'}
            </span>{' '}
            del plan{square.complete && !catalog ? ' · ✓ cada largo completo' : ''}
          </span>
          <span>
            Despunte total{' '}
            <span className="font-semibold tabular-nums">{scrapTotal.toFixed(3)} kg</span>
            {consumedTotal.gt(0) && <> · {scrapTotal.div(consumedTotal).times(100).toFixed(1)} %</>}
          </span>
        </div>
      )}

      {commitError !== null && commitError.coilId === null && (
        <p role="alert" className="text-sm text-destructive">
          {commitError.message}
        </p>
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
          covered={
            order.planItems.length > 0
              ? `Plan cubierto: ${String(square.covered)} de ${String(square.planned)} ${catalog ? 'und' : 'planchas'}.`
              : undefined
          }
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
          <CloseHint view={progress} unitWord={catalog ? 'und' : 'planchas'} />
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {Object.values(drafts.states).some((s) => s.saving)
              ? 'Guardando…'
              : Object.keys(drafts.edits).length > 0
                ? 'Sin guardar todavía'
                : 'Todo lo escrito está guardado'}
          </span>
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

      <PlanAdjustDialog
        order={order}
        open={planOpen !== null}
        onOpenChange={(open) => {
          if (!open) setPlanOpen(null);
        }}
        addLengthM={planOpen?.addLengthM}
        onSaved={() => {
          invalidate();
        }}
      />

      <ReasonDialog
        open={askingReason}
        onOpenChange={(open) => {
          if (!open) reason.current = null;
          setAskingReason(open);
        }}
        title="Cerrar con despunte alto"
        description={`El despunte pasa del ${String(MAX_SCRAP_RATIO_WITHOUT_REASON * 100)} % de lo consumido y sale del inventario; su costo se reparte entre el producto bueno. Si el material sigue entero en el almacén, vuelve y declara menos kilos consumidos en la bobina. Si de verdad salió como despunte, explica por qué.`}
        confirmLabel="Seguir con el cierre"
        pending={busy}
        onConfirm={(value: string) => {
          reason.current = value;
          setAskingReason(false);
          closing.current = true;
          void run.attempt(backdate.current);
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

// ---------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------

export function BandHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 rounded-lg bg-muted px-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function BlockCard({
  block,
  order,
  catalog,
  busy,
  attempted,
  saveState,
  commitError,
  override,
  onOverride,
  onEdit,
  onBlur,
  onOtherLength,
  onConfirmAuto,
  onClearAuto,
  onFold,
  onRelease,
}: {
  block: Block;
  order: RoofingBatchOrderDto;
  catalog: boolean;
  busy: boolean;
  attempted: boolean;
  saveState: { saving: boolean; error: string | null } | undefined;
  commitError: string | null;
  override: ToleranceOverrideState;
  onOverride: (next: ToleranceOverrideState) => void;
  onEdit: (next: BlockEdit) => void;
  onBlur: () => void;
  onOtherLength: () => void;
  /** D-575: el bloque se llenó solo y no se confirmó: «Sí, salió así». */
  onConfirmAuto: (() => void) | undefined;
  /** D-575: «Vaciar» el bloque llenado solo. */
  onClearAuto: (() => void) | undefined;
  onFold: (() => void) | undefined;
  onRelease: (() => void) | undefined;
}) {
  const { coil, figures } = block;
  const planLengths = [...new Set(order.planItems.map((p) => lengthLabel(p.lengthMm)))];
  const label = `la bobina ${String(block.index)} (${coil.coilCode})`;
  const setRow = (i: number, patch: Partial<PieceRow>) => {
    onEdit({ rows: editRow(block.rows, i, patch), consumedKg: block.consumedKg });
  };
  const fixedLength = catalog ? lengthLabel(order.productLengthMm ?? '0') : null;
  const error = commitError ?? saveState?.error ?? block.parseError ?? figures.error;
  const missingOverride =
    figures.excess !== null && overrideInput(override, figures.excess) === null;
  const auto = onConfirmAuto !== undefined;

  return (
    <div
      id={`bloque-${coil.coilId}`}
      data-testid={`bloque-${coil.coilCode}`}
      data-auto={auto ? 'sin-confirmar' : undefined}
      className={cn(
        'grid content-start gap-2.5 rounded-xl border p-3.5',
        auto && 'border-dashed border-tone-warning-foreground bg-tone-warning/40',
        error !== null && 'border-destructive/50',
      )}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onBlur();
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xs text-muted-foreground">
            Bobina {block.index} · saldo {formatQtyAsIs(coil.remainingKg, 'kg')}
            {toDecimal(coil.consumedKg).gt(0) && (
              <> · ya registrado {formatQtyAsIs(coil.consumedKg, 'kg')}</>
            )}
          </div>
          <div className="font-mono font-semibold">{coil.coilCode}</div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
          {auto ? (
            <span className="font-semibold text-tone-warning-foreground">
              Llenado solo · sin confirmar
            </span>
          ) : (
            <CoilStatusBadge
              inDraft={block.pieces.length > 0}
              registered={toDecimal(coil.reportedMeters).gt(0)}
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
          {onFold && (
            <Button
              variant="link"
              size="sm"
              aria-label={`Plegar la bobina ${coil.coilCode}`}
              onClick={onFold}
            >
              Plegar
            </Button>
          )}
          {onRelease && (
            <Button
              variant="link"
              size="sm"
              aria-label={`Bajar la bobina ${coil.coilCode} de ${order.code}`}
              disabled={busy}
              onClick={onRelease}
            >
              Bajar
            </Button>
          )}
        </div>
      </div>
      {coil.reportedPieces.length > 0 && (
        <p className="text-xs text-muted-foreground tabular-nums">
          Registrado: {cutsLabel(coil.reportedPieces)} · {formatMeters(coil.reportedMeters)}
        </p>
      )}
      {auto && (
        <div className="grid gap-1.5" data-testid="bloque-llenado-solo">
          <p className="text-muted-foreground tabular-nums">
            {cutsLabel(block.pieces).replaceAll(', ', ' · ')} = {formatMeters(figures.meters)}, lo
            que falta del plan
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              aria-label={`Sí, salió así en ${label}`}
              disabled={busy}
              onClick={onConfirmAuto}
            >
              Sí, salió así
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Vaciar ${label}`}
              disabled={busy}
              onClick={onClearAuto}
            >
              Vaciar
            </Button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border">
        <div className="grid grid-cols-[minmax(0,1fr)_7.5rem_5.5rem_2rem] items-center gap-2 bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground">
          <span>{catalog ? 'Producto' : 'Largo'}</span>
          <span className="text-right">{catalog ? 'Unidades' : 'Planchas'}</span>
          <span className="text-right">Metros</span>
          <span />
        </div>
        {block.rows.map((row, i) => (
          <div
            key={i}
            className="grid grid-cols-[minmax(0,1fr)_7.5rem_5.5rem_2rem] items-center gap-2 border-t px-2.5 py-1.5"
          >
            {catalog ? (
              <span className="font-semibold">Plancha {fixedLength} m</span>
            ) : (
              <select
                aria-label={`Largo del corte ${String(i + 1)} de ${label}`}
                className="h-8 rounded-md border bg-background px-2 text-sm font-semibold tabular-nums"
                disabled={busy}
                value={row.lengthM}
                onChange={(e) => {
                  setRow(i, { lengthM: e.target.value });
                }}
              >
                <option value="">Elige el largo…</option>
                {[...new Set([...planLengths, ...(row.lengthM ? [row.lengthM] : [])])].map(
                  (length) => (
                    <option key={length} value={length}>
                      {length} m
                    </option>
                  ),
                )}
              </select>
            )}
            <div className="relative">
              <Input
                aria-label={`${catalog ? 'Unidades' : 'Planchas'} del corte ${String(i + 1)} de ${label}`}
                inputMode="numeric"
                className="h-8 pr-8 text-right tabular-nums"
                disabled={busy}
                value={row.qty}
                onChange={(e) => {
                  setRow(
                    i,
                    catalog
                      ? { lengthM: fixedLength ?? '', qty: e.target.value }
                      : { qty: e.target.value },
                  );
                }}
              />
              <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground">
                {catalog ? 'und' : 'pl'}
              </span>
            </div>
            <span className="text-right text-sm tabular-nums text-muted-foreground">
              {rowMeters(catalog ? (fixedLength ?? '') : row.lengthM, row.qty)}
            </span>
            {!catalog && (row.lengthM !== '' || row.qty !== '') ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Quitar el corte ${String(i + 1)} de ${label}`}
                disabled={busy}
                onClick={() => {
                  onEdit({
                    rows: block.rows.filter((_, j) => j !== i),
                    consumedKg: block.consumedKg,
                  });
                }}
              >
                ✕
              </Button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
      {!catalog && (
        <Button
          variant="link"
          size="sm"
          className="justify-self-start px-0"
          aria-label={`Otro largo en ${label}`}
          disabled={busy}
          onClick={onOtherLength}
        >
          + Otro largo
        </Button>
      )}

      <p className="text-sm text-muted-foreground tabular-nums">
        {figures.meters.toFixed(3)} m · teórico {figures.theoreticalKg.toFixed(3)} kg
      </p>

      <div className="flex items-center gap-2">
        <label className="text-sm" htmlFor={`kg-${coil.coilId}`}>
          kg consumidos <span className="text-muted-foreground">· opcional</span>
        </label>
        <div className="relative w-36">
          <Input
            id={`kg-${coil.coilId}`}
            aria-label={`kg consumidos de ${label}`}
            inputMode="decimal"
            className="h-8 pr-8 text-right tabular-nums"
            placeholder={figures.theoreticalKg.toFixed(3)}
            disabled={busy}
            value={block.consumedKg}
            onChange={(e) => {
              onEdit({
                rows: block.rows.filter((r) => r.lengthM.trim() !== '' || r.qty.trim() !== ''),
                consumedKg: e.target.value,
              });
            }}
          />
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground">
            kg
          </span>
        </div>
      </div>

      <div className="flex justify-between text-sm tabular-nums">
        <span>
          Despunte <span className="font-semibold">{figures.scrapKg.toFixed(3)} kg</span>
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
            attempted && missingOverride && 'ring-2 ring-destructive/50',
          )}
        >
          <ToleranceOverrideRow
            title={`Bobina ${String(block.index)} (${coil.coilCode})`}
            label={label}
            excess={figures.excess}
            value={override}
            onChange={onOverride}
            disabled={busy}
          />
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="text-right text-[11px] text-muted-foreground">
        {saveState?.saving ? 'Guardando…' : null}
      </p>
    </div>
  );
}

/**
 * «Qué va a pasar» antes de «Registrar y cerrar» (ESPEC §1): lo calcula el API corriendo el cierre
 * real en una transacción que se deshace (D-453). Despunte por bobina (cc34), qué bobinas se
 * terminan y con cuánto vuelven las demás, y que la orden queda cerrada.
 */
export function ClosePreviewBlock({
  order,
  preview,
  pending,
  onBack,
  onConfirm,
  covered,
  autoIncluded = null,
}: {
  order: RoofingBatchOrderDto;
  preview: PlantClosePreviewDto;
  pending: boolean;
  onBack: () => void;
  onConfirm: () => void;
  /** «Plan cubierto: N de M planchas» (accesorio: metros); sin plan, nada. */
  covered?: string | undefined;
  /** D-575: el bloque llenado solo que se confirmó con la casilla (su descripción). */
  autoIncluded?: string | null;
}) {
  /**
   * Un doble clic llega antes de que React repinte `pending`: la guarda va por ref. Cada vista
   * previa es una instancia nueva (`key`), así que tras un error se puede confirmar otra vez.
   */
  const fired = useRef(false);
  const withScrap = preview.coils.filter((c) => toDecimal(c.scrapKg ?? '0').gt(0));
  const terminated = preview.coils.filter((c) => c.terminated);
  const back = preview.coils.filter((c) => !c.terminated);
  // cc29 (D-469): con más del 10 % de lo montado como despunte, la pregunta de si el material
  // sigue en el almacén para otra OP (la traía el diálogo de D-453; no se pierde).
  const mountedKg = sum(order.coils.map((c) => toDecimal(c.consumedKg).plus(c.remainingKg)));
  const highScrap =
    mountedKg.gt(0) &&
    toDecimal(preview.scrapKg).gt(mountedKg.times(MAX_SCRAP_RATIO_WITHOUT_REASON));
  return (
    <section
      aria-label="Qué va a pasar"
      data-testid="que-va-a-pasar"
      className="grid gap-1.5 rounded-lg bg-muted px-4 py-3 text-sm"
    >
      <h3 className="font-semibold">Qué va a pasar</h3>
      {autoIncluded !== null && (
        <p>
          <b>Incluye {autoIncluded}</b> ·{' '}
          <span className="inline-flex items-center gap-2 align-middle">
            <Checkbox checked disabled aria-label="Confirmo que salieron" />
            Confirmo que salieron
          </span>
        </p>
      )}
      <p>
        Despunte {formatQtyAsIs(preview.scrapKg, 'kg')}
        {withScrap.length > 0 &&
          `: ${withScrap.map((c) => `${formatQtyAsIs(c.scrapKg ?? '0', 'kg')} de ${c.coilCode}`).join(', ')}`}
        .
      </p>
      {terminated.length > 0 && (
        <p>
          {terminated.length === 1 ? 'Se termina' : 'Se terminan'}{' '}
          {terminated.map((c) => c.coilCode).join(', ')}.
        </p>
      )}
      {back.length > 0 && (
        <p>
          {back
            .map(
              (c) => `${c.coilCode} vuelve al almacén con ${formatQtyAsIs(c.balanceAfterKg, 'kg')}`,
            )
            .join('. ')}
          .
        </p>
      )}
      {preview.outOfTolerance.map((line) => (
        <p key={line}>⚠ {line}</p>
      ))}
      {preview.warnings.map((line) => (
        <p key={line}>⚠ {line}</p>
      ))}
      {highScrap && (
        <p
          role="alert"
          data-testid="aviso-sigue-en-almacen"
          className="rounded-md border border-tone-warning-foreground/30 bg-tone-warning p-2"
        >
          <span className="font-medium">¿Sigue en el almacén para otra OP?</span> El despunte pasa
          del {String(MAX_SCRAP_RATIO_WITHOUT_REASON * 100)} % de lo montado (
          {formatQtyAsIs(mountedKg.toFixed(3), 'kg')}). Si el material está entero, vuelve y declara
          menos kilos consumidos en la bobina: lo que no se consume vuelve al almacén.
        </p>
      )}
      <p className="font-medium">
        {covered !== undefined && <>{covered} </>}
        {order.code} queda cerrada con el plan completo.
      </p>
      <div className="mt-1 flex justify-end gap-2">
        <Button variant="outline" autoFocus onClick={onBack} disabled={pending}>
          Volver
        </Button>
        <Button
          pending={pending}
          pendingText="Registrando…"
          onClick={() => {
            if (fired.current || pending) return;
            fired.current = true;
            onConfirm();
          }}
        >
          Confirmar: registrar y cerrar
        </Button>
      </div>
    </section>
  );
}

/**
 * D-575 (tablero `CerrarBarra`): «Registrar y cerrar» con un bloque llenado solo y sin confirmar
 * pide confirmarlo en «Qué va a pasar». La casilla lo pasa al borrador y recién entonces el API
 * calcula el resumen: sin confirmar, el bloque no entra a ningún commit ni a la vista previa.
 */
export function AutoConfirmBlock({
  label,
  pending,
  onConfirm,
  onBack,
}: {
  label: string;
  pending: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <section
      aria-label="Qué va a pasar"
      data-testid="confirmar-llenado-solo"
      className="grid gap-1.5 rounded-lg bg-muted px-4 py-3 text-sm"
    >
      <h3 className="font-semibold">Qué va a pasar</h3>
      <p>
        <b>Incluye {label}</b> ·{' '}
        <label className="inline-flex items-center gap-2 align-middle">
          <Checkbox
            checked={false}
            disabled={pending}
            aria-label="Confirmo que salieron"
            onCheckedChange={(checked) => {
              if (checked === true) onConfirm();
            }}
          />
          Confirmo que salieron
        </label>
      </p>
      <p className="text-muted-foreground">
        Al confirmarlas se calcula el despunte de cada bobina y con cuánto vuelve al almacén.
      </p>
      <div className="mt-1 flex justify-end">
        <Button variant="outline" autoFocus onClick={onBack} disabled={pending}>
          Volver
        </Button>
      </div>
    </section>
  );
}
