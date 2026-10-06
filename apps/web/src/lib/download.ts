import { ApiError } from '@/lib/api';

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

/** El mensaje de un rechazo del API, con el mismo criterio que `api()`. */
export async function downloadErrorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: unknown };
  const message = Array.isArray(body.message) ? body.message.join(' · ') : body.message;
  return typeof message === 'string' && message.trim() !== ''
    ? message
    : `No se pudo descargar el archivo (error ${String(res.status)})`;
}

/** Descarga `href` (una ruta `/api/...`) y la guarda; lanza `ApiError` si el API la rechaza. */
export async function downloadFile(href: string): Promise<void> {
  const res = await fetch(href, { credentials: 'include' });
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
