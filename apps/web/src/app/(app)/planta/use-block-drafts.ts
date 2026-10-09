'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  toDecimal,
  type RoofingBatchOrderDto,
  type RoofingPieceDto,
  type RoofingReportDraftDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/notify';
import { parsePieceRows, type PieceRow } from '@/lib/pieces';
import { piecesMeters } from '@ayr/shared';
import { coilOfRowError, withoutRowPrefix } from '@/lib/production-blocks';

/**
 * cc35 (ESPEC §1): **lo que se escribe en los bloques se guarda solo en el borrador de la orden**
 * (D-191), así que sobrevive a un refresco o a un corte de luz. Un bloque es una fila del borrador:
 * bobina, cortes y kg consumidos. El supervisor no ve el borrador como tal: no hay «Agregar»,
 * «Corregir» ni «Ejecutar borrador».
 *
 * - Cada cambio espera un momento (o la salida del campo) y se guarda: `POST` si la bobina no tiene
 *   fila, `PUT` si ya la tiene (y se quitan las de más, de un borrador viejo con dos filas de la
 *   misma bobina), `DELETE` si el bloque quedó vacío. El API valida en el acto (D-191) y su error
 *   se muestra en el bloque.
 * - Los guardados van **de a uno, en orden**: el tope del plan (D-146) se mide sobre todo el
 *   borrador, y dos escrituras cruzadas podían rechazarse entre sí.
 * - La clave de idempotencia de un alta va atada al contenido (D-182).
 */

export interface BlockEdit {
  rows: PieceRow[];
  consumedKg: string;
}

export interface BlockSaveState {
  saving: boolean;
  /** El último rechazo del API al guardar este bloque. */
  error: string | null;
}

/** El contenido de un bloque listo para el API, o el motivo por el que todavía no lo está. */
export function blockPayload(edit: BlockEdit):
  | { ok: true; pieces: RoofingPieceDto[]; consumedKg: string | null; empty: boolean }
  | {
      ok: false;
      reason: string;
    } {
  const filled = edit.rows.filter((r) => r.lengthM.trim() !== '' || r.qty.trim() !== '');
  const kg = edit.consumedKg.trim();
  if (filled.length === 0) {
    return kg === ''
      ? { ok: true, pieces: [], consumedKg: null, empty: true }
      : { ok: false, reason: 'Escribe los cortes de esta bobina antes de sus kilos.' };
  }
  const parsed = parsePieceRows(filled);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (kg !== '' && (!/^\d+(\.\d{1,3})?$/.test(kg) || toDecimal(kg).lte(0))) {
    return { ok: false, reason: 'Los kilos van con hasta tres decimales y mayores a cero.' };
  }
  return {
    ok: true,
    pieces: parsed.pieces,
    consumedKg: kg === '' ? null : toDecimal(kg).toFixed(3),
    empty: false,
  };
}

function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const SAVE_DELAY_MS = 700;

/**
 * `onSaved` recibe la lista del borrador que devolvió el API: quien llama la escribe en la caché
 * de la pantalla, sin volver a pedir todo (revisión de cc35).
 */
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

  const draftsOf = (coilId: string) => latest.current.filter((d) => d.coilId === coilId);

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
      const existing = draftsOf(coilId);
      const base = `/production/roofing/${order.orderId}/drafts`;
      try {
        let list: RoofingReportDraftDto[] | null = null;
        if (payload.empty) {
          for (const d of existing) {
            list = await api<RoofingReportDraftDto[]>(`${base}/${d.id}`, { method: 'DELETE' });
          }
        } else {
          const body = {
            coilId,
            pieces: payload.pieces.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty })),
            ...(payload.consumedKg === null ? {} : { consumedKg: payload.consumedKg }),
          };
          const [first, ...rest] = existing;
          for (const d of rest) {
            list = await api<RoofingReportDraftDto[]>(`${base}/${d.id}`, { method: 'DELETE' });
          }
          if (first === undefined) {
            const fingerprint = `${coilId}:${JSON.stringify(body)}`;
            let key = keys.current.get(fingerprint);
            if (key === undefined) {
              key = newKey();
              keys.current.set(fingerprint, key);
            }
            list = await api<RoofingReportDraftDto[]>(base, {
              method: 'POST',
              body: { ...body, idempotencyKey: key },
            });
            keys.current.delete(fingerprint);
          } else {
            list = await api<RoofingReportDraftDto[]>(`${base}/${first.id}`, {
              method: 'PUT',
              body,
            });
          }
        }
        if (list !== null) {
          latest.current = list;
          // La caché de la pantalla pasa a tener este borrador antes de soltar la edición: el
          // bloque nunca vuelve a leer el borrador viejo.
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
        const message = errorMessage(err, 'No se pudo guardar la bobina');
        // «Fila N: …» nombra otra fila del borrador (el estado cambió por debajo): va a su bloque.
        const other = coilOfRowError(message, latest.current);
        setStates((prev) => ({
          ...prev,
          [coilId]: {
            saving: false,
            error: other === null || other === coilId ? withoutRowPrefix(message) : null,
          },
          ...(other === null || other === coilId
            ? {}
            : { [other]: { saving: false, error: withoutRowPrefix(message) } }),
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

  /** Guarda todo lo pendiente, en `order` (el orden de los bloques), y espera. */
  const flush = useCallback(
    async (orderOf: readonly string[]): Promise<boolean> => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
      let ok = true;
      // Primero lo que baja: el tope del plan (D-146) mide todo el borrador.
      const growth = (coilId: string) =>
        toDecimal(editMeters(editsRef.current[coilId])).minus(
          piecesMeters(draftsOf(coilId).flatMap((d) => d.pieces)),
        );
      const dirty = orderOf
        .filter((coilId) => editsRef.current[coilId] !== undefined)
        .sort((a, b) => growth(a).comparedTo(growth(b)));
      for (const coilId of dirty) {
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
    clearError: (coilId: string) => {
      setStates((s) => ({ ...s, [coilId]: { saving: false, error: null } }));
    },
  };
}

/** Metros de un borrador de bloque, para decidir el orden de los guardados. */
export function editMeters(edit: BlockEdit | undefined): string {
  if (edit === undefined) return '0';
  const payload = blockPayload(edit);
  return payload.ok ? piecesMeters(payload.pieces).toFixed(3) : '0';
}
