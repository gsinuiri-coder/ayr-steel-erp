import type { MountedKgExcess } from '@ayr/shared';

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
     * `TOLERANCE_OVERRIDE_REQUIRED`: las cifras para ofrecer la casilla).
     */
    public readonly details?: { excess?: MountedKgExcess },
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  message?: string | string[];
  errors?: Record<string, string[] | undefined>;
  code?: string;
  excess?: MountedKgExcess;
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
  const raw = Array.isArray(body.message) ? body.message.join(', ') : body.message;
  // cc31: un 5xx sin motivo propio (o con el «Internal server error» genérico de Nest, o el de
  // una pasarela) se dice en castellano y sin número: nadie puede hacer nada con «Error 500».
  let message = raw ?? `No se pudo completar la operación (${String(res.status)})`;
  if (res.status >= 500 && (raw === undefined || GENERIC_SERVER_ERRORS.has(raw))) {
    message = SERVER_DOWN_MESSAGE;
  }
  // El límite de intentos responde con el texto en inglés de la librería
  // («ThrottlerException: Too Many Requests»).
  if (res.status === 429) message = TOO_MANY_REQUESTS_MESSAGE;
  return new ApiError(
    res.status,
    message,
    body.errors,
    body.code,
    body.excess === undefined ? undefined : { excess: body.excess },
  );
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
    }).catch(() => {
      // cc31: sin red o sin servidor, `fetch` rechaza con «Failed to fetch». Se convierte en un
      // `ApiError` de estado 0 para que toda vista lo muestre igual que cualquier otro error.
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
