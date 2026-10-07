import { ApiError, errorTextFor, SERVER_DOWN_MESSAGE, tryRefresh } from '@/lib/api';

/**
 * cc28 (D-446, P3 de cc26): las descargas del API (Excel, PDF) pasan por `fetch`.
 *
 * Con un `<a href>` suelto, un rechazo del API —el 400 del tope de 5000 filas del Excel de una
 * lista, un 403— se abría en el navegador como texto JSON, sin salida. Ahora el enlace sigue siendo
 * un enlace (se ve, se copia y se abre con el botón del medio), pero el clic normal descarga por
 * `fetch`: un 2xx se guarda con el nombre que manda el API y un error se lanza con su mensaje,
 * para mostrarlo en un aviso.
 */

/** El nombre del archivo del `Content-Disposition` (`filename*` UTF-8 primero), o `null`. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // Codificación rota: se prueba con `filename=`.
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(header);
  const name = plain?.[2] ?? plain?.[1];
  return name ? name.trim() : null;
}

const GENERIC_CLIENT_ERRORS =
  /^(Unauthorized|Forbidden|Forbidden resource|Not Found|Bad Request|Cannot (GET|POST|PUT|PATCH|DELETE) .*)$/;

/**
 * El mensaje de un rechazo del API, con el mismo criterio que `api()`. cc32 (P3 de cc31): sin
 * motivo legible, el aviso dice qué pasó en español y nunca el código («error 500»).
 */
export async function downloadErrorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: unknown };
  const joined = Array.isArray(body.message) ? body.message.join(' · ') : body.message;
  const text0 = typeof joined === 'string' && joined.trim() !== '' ? joined : undefined;
  // Los rechazos genéricos de NestJS vienen en inglés («Forbidden resource», «Cannot GET …»):
  // no son un motivo de negocio y se reemplazan por el texto en español de su código.
  const raw = text0 !== undefined && GENERIC_CLIENT_ERRORS.test(text0) ? undefined : text0;
  if (raw !== undefined || res.status === 429) {
    const text = errorTextFor(res.status, raw);
    if (text !== SERVER_DOWN_MESSAGE) return text;
  }
  if (res.status >= 500)
    return `No se pudo descargar el archivo: ${SERVER_DOWN_MESSAGE.toLowerCase()}.`;
  if (res.status === 403) return 'No tienes permiso para descargar este archivo.';
  if (res.status === 404) return 'No se encontró el archivo: puede que ya no exista.';
  if (res.status === 401) return 'Tu sesión venció. Ingresa de nuevo y vuelve a descargar.';
  return 'No se pudo descargar el archivo.';
}

/** Los enlaces que se están descargando: un doble clic no arranca dos exportaciones (SM-3). */
const inFlight = new Set<string>();

/**
 * Descarga `href` (una ruta `/api/...`) y la guarda; lanza `ApiError` si el API la rechaza. Con
 * un 401 refresca la sesión una vez y reintenta, como `api()` (segundo modelo cc28, SM-2).
 */
export async function downloadFile(href: string): Promise<void> {
  if (inFlight.has(href)) return;
  inFlight.add(href);
  try {
    await fetchAndSave(href);
  } finally {
    inFlight.delete(href);
  }
}

async function fetchAndSave(href: string): Promise<void> {
  // Un corte de red sale como «El servidor no respondió», igual que en `api()`.
  const get = () =>
    fetch(href, { credentials: 'include', cache: 'no-store' }).catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError(0, SERVER_DOWN_MESSAGE, undefined, 'NETWORK');
    });
  let res = await get();
  if (res.status === 401 && (await tryRefresh())) res = await get();
  if (!res.ok) throw new ApiError(res.status, await downloadErrorMessage(res));
  const blob = await res.blob();
  const name =
    filenameFromDisposition(res.headers.get('content-disposition')) ??
    href.split('?')[0]?.split('/').pop() ??
    'descarga';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // El navegador ya tomó el blob; se libera después de que arranque la descarga.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}
