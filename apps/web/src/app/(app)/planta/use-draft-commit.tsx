'use client';

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BACKDATE_OUT_OF_ORDER,
  sum,
  TOLERANCE_OVERRIDE_REQUIRED,
  toDecimal,
  type PlantClosePreviewDto,
  type ProductionOrderDto,
  type RoofingBatchOrderDto,
  type RoofingReportDraftDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { errorMessage, toast } from '@/lib/notify';
import { coilOfRowError, withoutRowPrefix } from '@/lib/production-blocks';
import { invalidateProduction } from '@/lib/production-queries';
import { useBackdateConfirm } from '@/lib/use-backdate-confirm';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import type { BlockSaveState } from './use-block-drafts';

/**
 * cc41 (D-591): lo que comparten las dos pantallas del modelo M que escriben en el borrador de la
 * orden (D-191) —coberturas (`ProduceBlocks`) y accesorio (`ProduceAccessory`)—: la caché del
 * borrador guardado, y registrar el borrador entero (`…/drafts/commit`, todo o nada) con su vista
 * previa «Qué va a pasar» (cc27, D-453), la retro-fecha (D-124) y el motivo del despunte alto.
 */

/**
 * Guardar un bloque no toca el kardex: el borrador que devolvió el API va a la caché de la orden,
 * sin volver a pedir todas las órdenes (revisión de cc35: cada pausa refrescaba todo).
 */
export function useDraftsCache(orderId: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (list: RoofingReportDraftDto[]) => {
      queryClient.setQueriesData<RoofingBatchOrderDto[]>({ queryKey: ['roofing-batch'] }, (old) =>
        old?.map((o) =>
          o.orderId === orderId
            ? {
                ...o,
                drafts: list,
                draftMeters: sum(list.map((d) => toDecimal(d.meters))).toFixed(3),
              }
            : o,
        ),
      );
    },
    [queryClient, orderId],
  );
}

export interface DraftToleranceOverride {
  draftId: string;
  [field: string]: unknown;
}

export function useDraftCommit(input: {
  order: RoofingBatchOrderDto;
  operationDate: string | undefined;
  /** El borrador más nuevo conocido (`useBlockDrafts().latestDrafts`). */
  latestDrafts: () => RoofingReportDraftDto[];
  /** Las casillas de tolerancia listas, por fila del borrador (D-388/D-389). */
  toleranceOverrides: () => DraftToleranceOverride[];
  /** Tras registrar: los avisos del agregado que devolvió el API (D-154). */
  onUpdated: (updated: ProductionOrderDto | null) => void;
  /** Tras registrar: lo que la pantalla limpia (casillas, intento). */
  onCommitted: () => void;
  /** Un rechazo que nombra la fila de una bobina (para abrir su bloque). */
  onRowError?: (coilId: string) => void;
}) {
  const { order, operationDate, latestDrafts, onUpdated, onCommitted, onRowError } = input;
  const queryClient = useQueryClient();
  const invalidate = useCallback(() => {
    invalidateProduction(queryClient, order.orderId);
  }, [queryClient, order.orderId]);
  /** El error del último registro, en el bloque de su bobina (o arriba si no nombra una fila). */
  const [commitError, setCommitError] = useState<{ coilId: string | null; message: string } | null>(
    null,
  );
  const [preview, setPreview] = useState<PlantClosePreviewDto | null>(null);
  const [askingReason, setAskingReason] = useState(false);
  const reason = useRef<string | null>(null);
  const closing = useRef(false);
  const backdate = useRef(false);

  const submitKey = useIdempotencyKey();
  const body = (close: boolean) => {
    const toleranceOverrides = input.toleranceOverrides();
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
          rows: latestDrafts().map((d) => [d.id, d.meters, d.piecesCount ?? null, d.consumedKg]),
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
    const coilId = coilOfRowError(message, latestDrafts());
    setCommitError({ coilId, message: coilId === null ? message : withoutRowPrefix(message) });
    if (coilId !== null) onRowError?.(coilId);
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
      setPreview(null);
      setCommitError(null);
      reason.current = null;
      onCommitted();
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

  return {
    invalidate,
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
    backdate,
    closing,
  };
}

/** El estado del guardado del borrador, al pie de la pantalla (cc35). */
export function DraftSaveStatus({
  states,
  edits,
}: {
  states: Record<string, BlockSaveState>;
  edits: Record<string, unknown>;
}) {
  return (
    <span className="text-xs text-muted-foreground" aria-live="polite">
      {Object.values(states).some((s) => s.saving)
        ? 'Guardando…'
        : Object.keys(edits).length > 0
          ? 'Sin guardar todavía'
          : 'Todo lo escrito está guardado'}
    </span>
  );
}
