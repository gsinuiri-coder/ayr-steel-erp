/**
 * Cliente HTTP del web. Habla con `/api/*` (mismo origen; Next reenvía al API, D-015).
 * Si recibe 401 intenta un refresh (una sola vez, en vuelo compartido) y reintenta.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly errors?: Record<string, string[] | undefined>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  message?: string | string[];
  errors?: Record<string, string[] | undefined>;
}

let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
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
  const message = Array.isArray(body.message)
    ? body.message.join(', ')
    : (body.message ?? `Error ${res.status}`);
  return new ApiError(res.status, message, body.errors);
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
    });

  let res = await doFetch();
  if (res.status === 401 && !options.noRefresh && (await tryRefresh())) {
    res = await doFetch();
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
