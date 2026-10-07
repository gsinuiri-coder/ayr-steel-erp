import { toast as sonner, type ExternalToast } from 'sonner';
import { ApiError, SERVER_DOWN_MESSAGE } from '@/lib/api';

export { SERVER_DOWN_MESSAGE };

/**
 * cc31: los mensajes de resultado, con una sola regla para toda la app.
 *
 * - El **éxito** dura 6 s y puede traer el paso siguiente (`action`).
 * - El **error** se queda hasta que lo cierren y dice el motivo: a los 4 s se iba sin que
 *   nadie alcanzara a leer por qué SUNAT rechazó un comprobante.
 * - La **advertencia** va en amarillo y también se queda: una reserva que quedó incompleta no es
 *   un éxito, y en verde se leía como tal.
 *
 * Las vistas importan `toast` de aquí y no de `sonner`; la firma es la misma.
 */
export const SUCCESS_DURATION_MS = 6000;

/** Los textos con que cada navegador rechaza un `fetch` sin red. */
const NETWORK_ERROR = /failed to fetch|networkerror|load failed|network request failed/i;

/**
 * Sin respuesta no se puede saber si el servidor alcanzó a guardar (D-182): el texto no lo
 * afirma. Reintentar es seguro: la operación lleva su clave de idempotencia.
 */
export const SERVER_DOWN_HINT =
  'Puede que no se haya guardado. Lo que escribiste sigue en pantalla: vuelve a intentar.';

type Message = Parameters<typeof sonner.error>[0];

const persistent: ExternalToast = { duration: Infinity, closeButton: true };

export const toast = Object.assign(
  (message: Message, data?: ExternalToast) => sonner(message, data),
  sonner,
  {
    success: (message: Message, data?: ExternalToast) =>
      sonner.success(message, { duration: SUCCESS_DURATION_MS, ...data }),
    error: (message: Message, data?: ExternalToast) =>
      sonner.error(message, {
        ...persistent,
        ...(message === SERVER_DOWN_MESSAGE ? { description: SERVER_DOWN_HINT } : {}),
        ...data,
      }),
    warning: (message: Message, data?: ExternalToast) =>
      sonner.warning(message, { ...persistent, ...data }),
  },
);

/**
 * El texto de un error para mostrar: el motivo que dio el API, «El servidor no respondió» si no
 * hubo respuesta, o `fallback` para cualquier otra cosa. Es el único lugar que arma ese texto.
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  // Un `fetch` propio (subidas, descargas) rechaza con `TypeError` cuando no hay red. Solo esos:
  // un `TypeError` de un defecto del código no es «el servidor no respondió».
  if (err instanceof TypeError && NETWORK_ERROR.test(err.message)) return SERVER_DOWN_MESSAGE;
  return fallback;
}
