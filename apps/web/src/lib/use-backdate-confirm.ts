'use client';

import { useCallback, useState } from 'react';
import { BACKDATE_OUT_OF_ORDER } from '@ayr/shared';
import { ApiError } from '@/lib/api';

/** Qué acuse manda el reintento: el de orden cronológico (D-124). */
export interface BackdateAck {
  confirmBackdate: boolean;
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
 * cc53 (D-650): ya no hay «Registrar igual» por costo (D-648): el kardex recostea por fecha los
 * movimientos posteriores.
 */
export function useBackdateConfirm(run: (confirmBackdate: boolean) => Promise<unknown>) {
  const [detail, setDetail] = useState<string | null>(null);

  const attempt = useCallback(
    async (ack: BackdateAck = { confirmBackdate: false }) => {
      try {
        await run(ack.confirmBackdate);
        setDetail(null);
      } catch (err) {
        if (err instanceof ApiError && err.code === BACKDATE_OUT_OF_ORDER) {
          setDetail(err.message);
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
    close: useCallback(() => {
      setDetail(null);
    }, []),
    /** Primer intento, sin confirmar (o repitiendo el acuse que ya se dio, en planta). */
    attempt: useCallback((ack?: BackdateAck) => attempt(ack), [attempt]),
    /** Reintento tras confirmar en el diálogo. */
    confirm: useCallback(() => attempt({ confirmBackdate: true }), [attempt]),
  };
}
