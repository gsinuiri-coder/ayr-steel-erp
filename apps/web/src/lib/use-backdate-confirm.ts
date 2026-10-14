'use client';

import { useCallback, useState } from 'react';
import { BACKDATE_COST_MISMATCH, BACKDATE_OUT_OF_ORDER } from '@ayr/shared';
import { ApiError } from '@/lib/api';

/** Qué acuse manda el reintento: el de orden (D-124) y, si hizo falta, «Registrar igual» (D-648). */
export interface BackdateAck {
  confirmBackdate: boolean;
  acceptBackdatedCost: boolean;
}

/**
 * El ida y vuelta del guardrail cronológico (D-124), en un solo lugar.
 *
 * Toda operación retrofechable lo usa igual: se intenta sin confirmar; si el API responde
 * con `BACKDATE_OUT_OF_ORDER` se guarda el mensaje y se abre el diálogo; si el usuario
 * confirma, se repite **la misma** operación con `confirmBackdate: true`. Vive acá y no
 * copiado en cada vista porque son media docena de pantallas y una copia que se olvide de
 * reintentar deja al usuario con un error que no explica cómo salir.
 *
 * cc52 (D-648): si la respuesta es `BACKDATE_COST_MISMATCH` (una salida atrasada que saldría a
 * otro costo), el diálogo muestra los dos costos y el reintento manda además
 * `acceptBackdatedCost: true` («Registrar igual»). Solo un ADMINISTRADOR la puede registrar: para
 * otro rol el API responde 403 y la mutación lo muestra.
 */
export function useBackdateConfirm(
  run: (confirmBackdate: boolean, acceptBackdatedCost: boolean) => Promise<unknown>,
) {
  const [detail, setDetail] = useState<string | null>(null);
  const [costMismatch, setCostMismatch] = useState(false);

  const attempt = useCallback(
    async (ack: BackdateAck = { confirmBackdate: false, acceptBackdatedCost: false }) => {
      try {
        await run(ack.confirmBackdate, ack.acceptBackdatedCost);
        setDetail(null);
        setCostMismatch(false);
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.code === BACKDATE_OUT_OF_ORDER || err.code === BACKDATE_COST_MISMATCH)
        ) {
          setDetail(err.message);
          setCostMismatch(err.code === BACKDATE_COST_MISMATCH);
          return;
        }
        // Cualquier otro error ya lo mostró el `onError` de la mutación. Relanzarlo acá solo
        // producía un rechazo sin manejar en cada fallo normal, porque todos los llamadores
        // invocan esto con `void attempt()` — no hay nadie que lo atrape.
      }
    },
    [run],
  );

  return {
    /** Mensaje del API cuando hay que confirmar; `null` cuando no hay nada pendiente. */
    detail,
    open: detail !== null,
    /** cc52 (D-648): lo pendiente es una salida que cambia de costo («Registrar igual»). */
    costMismatch,
    close: useCallback(() => {
      setDetail(null);
      setCostMismatch(false);
    }, []),
    /** Primer intento, sin confirmar (o repitiendo el acuse que ya se dio, en planta). */
    attempt: useCallback((ack?: BackdateAck) => attempt(ack), [attempt]),
    /** Reintento tras confirmar en el diálogo. */
    confirm: useCallback(
      () => attempt({ confirmBackdate: true, acceptBackdatedCost: costMismatch }),
      [attempt, costMismatch],
    ),
  };
}
