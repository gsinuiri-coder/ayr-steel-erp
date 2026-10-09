'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoofingBatchOrderDto, RoofingReportDraftDto } from '@ayr/shared';
import { api } from '@/lib/api';
import {
  blockPayload,
  flushOrder,
  saveBlockDraft,
  saveErrorTarget,
  type BlockEdit,
  type DraftCall,
} from '@/lib/block-drafts';
import { errorMessage } from '@/lib/notify';

/**
 * cc35 (ESPEC §1): el guardado automático de los bloques del modelo M en el borrador de la orden
 * (D-191), cableado con React. Lo que se manda y en qué orden vive en `lib/block-drafts.ts` (con
 * sus pruebas); acá queda la espera entre teclas, la cola y el estado de cada bloque. Es código de
 * pantalla: lo cubren los E2E de planta (D-011).
 *
 * - Cada cambio espera un momento (o la salida del bloque) y se guarda.
 * - Los guardados van **de a uno, en orden**: el tope del plan (D-146) se mide sobre todo el
 *   borrador, y dos escrituras cruzadas podían rechazarse entre sí.
 * - `onSaved` recibe el borrador que devolvió el API: la pantalla lo escribe en su caché antes de
 *   soltar la edición, así el bloque nunca vuelve a leer el borrador viejo.
 */

export interface BlockSaveState {
  saving: boolean;
  /** El último rechazo del API al guardar este bloque. */
  error: string | null;
}

const SAVE_DELAY_MS = 700;

/**
 * Una clave de idempotencia nueva. `randomUUID` solo existe en contexto seguro (HTTPS o
 * localhost); por la IP de la red local se arma con `getRandomValues`, que está siempre.
 */
export function newDraftKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const call: DraftCall = (path, init) => api<RoofingReportDraftDto[]>(path, init);

export function useBlockDrafts(
  order: RoofingBatchOrderDto,
  onSaved: (list: RoofingReportDraftDto[]) => void,
) {
  const [edits, setEdits] = useState<Record<string, BlockEdit>>({});
  const [states, setStates] = useState<Record<string, BlockSaveState>>({});
  /** El borrador que devolvió el último guardado: más nuevo que `order.drafts` hasta el refetch. */
  const latest = useRef<RoofingReportDraftDto[]>(order.drafts);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const keys = useRef(new Map<string, string>());
  /** Versión de la edición de cada bloque: un guardado viejo no borra una edición más nueva. */
  const versions = useRef(new Map<string, number>());

  useEffect(() => {
    latest.current = order.drafts;
  }, [order.drafts]);

  const saveNow = useCallback(
    async (coilId: string): Promise<boolean> => {
      const edit = editsRef.current[coilId];
      if (edit === undefined) return true;
      const version = versions.current.get(coilId) ?? 0;
      const payload = blockPayload(edit);
      if (!payload.ok) {
        setStates((s) => ({ ...s, [coilId]: { saving: false, error: payload.reason } }));
        return false;
      }
      setStates((s) => ({ ...s, [coilId]: { saving: true, error: null } }));
      try {
        const list = await saveBlockDraft({
          orderId: order.orderId,
          coilId,
          payload,
          existing: latest.current.filter((d) => d.coilId === coilId),
          call,
          keyFor: (fingerprint) => {
            let key = keys.current.get(fingerprint);
            if (key === undefined) {
              key = newDraftKey();
              keys.current.set(fingerprint, key);
            }
            return key;
          },
          onSent: (fingerprint) => keys.current.delete(fingerprint),
        });
        if (list !== null) {
          latest.current = list;
          onSaved(list);
        }
        // Si no se volvió a escribir mientras se guardaba, el bloque ya se lee del borrador.
        if ((versions.current.get(coilId) ?? 0) === version) {
          setEdits((prev) =>
            Object.fromEntries(Object.entries(prev).filter(([id]) => id !== coilId)),
          );
        }
        setStates((s) => ({ ...s, [coilId]: { saving: false, error: null } }));
        return true;
      } catch (err) {
        const target = saveErrorTarget(
          errorMessage(err, 'No se pudo guardar la bobina'),
          coilId,
          latest.current,
        );
        setStates((prev) => ({
          ...prev,
          [coilId]: { saving: false, error: target.coilId === coilId ? target.message : null },
          [target.coilId]: { saving: false, error: target.message },
        }));
        return false;
      }
    },
    // `order.orderId` fija la orden; el resto se lee por ref.
    [order.orderId, onSaved],
  );

  /** Pone el guardado en la fila y devuelve si salió bien. */
  const enqueue = useCallback(
    (coilId: string): Promise<boolean> => {
      const run = queue.current.then(() => saveNow(coilId));
      queue.current = run.catch(() => undefined);
      return run;
    },
    [saveNow],
  );

  /** Cambia un bloque y programa su guardado. */
  const edit = useCallback(
    (coilId: string, next: BlockEdit, options: { immediate?: boolean } = {}) => {
      versions.current.set(coilId, (versions.current.get(coilId) ?? 0) + 1);
      editsRef.current = { ...editsRef.current, [coilId]: next };
      setEdits(editsRef.current);
      const timer = timers.current.get(coilId);
      if (timer !== undefined) clearTimeout(timer);
      if (options.immediate) {
        timers.current.delete(coilId);
        void enqueue(coilId);
        return;
      }
      timers.current.set(
        coilId,
        setTimeout(() => {
          timers.current.delete(coilId);
          void enqueue(coilId);
        }, SAVE_DELAY_MS),
      );
    },
    [enqueue],
  );

  /** Guarda ya lo pendiente de un bloque (al salir del campo). */
  const flushOne = useCallback(
    (coilId: string) => {
      const timer = timers.current.get(coilId);
      if (timer === undefined) return;
      clearTimeout(timer);
      timers.current.delete(coilId);
      void enqueue(coilId);
    },
    [enqueue],
  );

  /** Guarda todo lo pendiente (primero lo que baja de metros) y espera. */
  const flush = useCallback(
    async (coilIds: readonly string[]): Promise<boolean> => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
      let ok = true;
      for (const coilId of flushOrder(coilIds, editsRef.current, latest.current)) {
        ok = (await enqueue(coilId)) && ok;
      }
      await queue.current;
      return ok;
    },
    [enqueue],
  );

  // Al salir de la pestaña, lo que estaba esperando se guarda igual.
  useEffect(
    () => () => {
      for (const [coilId, timer] of timers.current) {
        clearTimeout(timer);
        void enqueue(coilId);
      }
      timers.current.clear();
    },
    [enqueue],
  );

  return {
    edits,
    states,
    edit,
    flushOne,
    flush,
    /** El borrador más nuevo conocido (para el número de fila de un error y las casillas). */
    latestDrafts: () => latest.current,
  };
}
