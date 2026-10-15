import {
  BACKDATE_NEGATIVE_STOCK,
  backdateNegativeStockMessage,
  type BackdateNegativeStock,
  type MountedKgExcess,
} from '@ayr/shared';

/**
 * Cliente HTTP del web. Habla con `/api/*` (mismo origen; Next reenvía al API, D-015).
 * Si recibe 401 intenta un refresh (una sola vez, en vuelo compartido) y reintenta.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly errors?: Record<string, string[] | undefined>,
    /**
     * Código de dominio del error, cuando el API lo manda (hoy solo
     * `BACKDATE_OUT_OF_ORDER`, D-124). Es lo que deja distinguir "esto se puede reintentar
     * confirmando" de cualquier otro 400, sin reconocer el texto del mensaje.
     */
    public readonly code?: string,
    /**
     * D-389: el resto del cuerpo del error cuando trae datos de dominio (hoy, `excess` de
     * `TOLERANCE_OVERRIDE_REQUIRED`: las cifras para ofrecer la casilla). cc54: `negativeStock` de
     * `BACKDATE_NEGATIVE_STOCK` (D-652), con la primera fecha válida.
     */
    public readonly details?: { excess?: MountedKgExcess; negativeStock?: BackdateNegativeStock },
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ErrorBody {
  message?: string | string[];
  errors?: Record<string, string[] | undefined>;
  code?: string;
  excess?: MountedKgExcess;
  negativeStock?: BackdateNegativeStock;
}

/**
 * cc54 (P2-3 de la revisión de cc53): el rechazo de D-652 se lee igual en todos los caminos
 * (producción, corte, partido, anulaciones, compras, despacho): el texto se arma acá con los datos
 * del cuerpo, con fechas `DD/MM/YYYY` y la primera fecha válida, y no depende de cada vista.
 */
export function errorBodyText(status: number, body: ErrorBody): string {
  if (body.code === BACKDATE_NEGATIVE_STOCK && body.negativeStock !== undefined) {
    return backdateNegativeStockMessage(body.negativeStock);
  }
  const raw = Array.isArray(body.message) ? body.message.join(', ') : body.message;
  return errorTextFor(status, raw);
}

/** cc31: lo que se ve cuando el servidor no contesta o falla sin decir por qué. */
export const SERVER_DOWN_MESSAGE = 'El servidor no respondió';
export const TOO_MANY_REQUESTS_MESSAGE =
  'Demasiados intentos seguidos. Espera un minuto y vuelve a probar.';

const GENERIC_SERVER_ERRORS = new Set([
  'Internal server error',
  'Internal Server Error',
  'Bad Gateway',
  'Service Unavailable',
  'Gateway Timeout',
]);

/**
 * cc31: el texto de una respuesta de error. Un 5xx sin motivo propio (o con el «Internal server
 * error» genérico de Nest, o el de una pasarela) se dice en castellano y sin número: nadie puede
 * hacer nada con «Error 500». El límite de intentos llega con el texto en inglés de la librería
 * («ThrottlerException: Too Many Requests»). Lo usan `api()` y los `fetch` propios (subidas).
 */
export function errorTextFor(status: number, raw: string | undefined): string {
  if (status === 429) return TOO_MANY_REQUESTS_MESSAGE;
  if (status >= 500 && (raw === undefined || GENERIC_SERVER_ERRORS.has(raw))) {
    return SERVER_DOWN_MESSAGE;
  }
  return raw ?? 'No se pudo completar la operación.';
}

/**
 * El servidor respondió y rechazó la operación (4xx): no grabó nada y reintentar igual no
 * cambia el resultado. Un corte de red (`status` 0) o un 5xx **no** lo son: el desenlace es
 * incierto (D-182) y la clave de idempotencia tiene que sobrevivir para el reintento.
 */
export function isClientError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status >= 400 && err.status < 500;
}

let refreshInFlight: Promise<boolean> | null = null;

export async function tryRefresh(): Promise<boolean> {
  refreshInFlight ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

async function toError(res: Response): Promise<ApiError> {
  let body: ErrorBody = {};
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    /* sin cuerpo */
  }
  const details =
    body.excess === undefined && body.negativeStock === undefined
      ? undefined
      : { excess: body.excess, negativeStock: body.negativeStock };
  return new ApiError(res.status, errorBodyText(res.status, body), body.errors, body.code, details);
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** No intentar refresh al recibir 401 (login/refresh/logout). */
  noRefresh?: boolean;
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const doFetch = () =>
    fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
    }).catch((err: unknown) => {
      // Una petición cancelada (se navegó a otra pantalla) no es un error del servidor.
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      // cc31: sin red o sin servidor, `fetch` rechaza con «Failed to fetch». Se convierte en un
      // `ApiError` de estado 0 para que toda vista lo muestre igual que cualquier otro error.
      // Sigue siendo incierto para la idempotencia: ver `isClientError`.
      throw new ApiError(0, SERVER_DOWN_MESSAGE, undefined, 'NETWORK');
    });

  let res = await doFetch();
  if (res.status === 401 && !options.noRefresh && (await tryRefresh())) {
    res = await doFetch();
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
