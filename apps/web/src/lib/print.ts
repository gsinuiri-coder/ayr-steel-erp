import { fetchFile } from '@/lib/download';

/**
 * cc32 (§2 de la espec): «Imprimir» abre el diálogo de impresión con el mismo PDF que ya genera el
 * API, sin descargarlo.
 *
 * El PDF se pide por `fetch` con la misma puerta que la descarga (`fetchFile`: sesión, reintento
 * con 401 y mensaje en español si el API lo rechaza), se arma un blob y se carga en un `<iframe>`
 * oculto de la propia página; al cargar se llama a `print()` de ese iframe. El blob es del mismo
 * origen, así que la página puede pedirle que imprima.
 *
 * Si el navegador no deja imprimir el iframe, la alternativa menos distante es abrir el blob en
 * una pestaña nueva, donde el visor del navegador tiene su propio botón de imprimir. Si además el
 * navegador bloquea la pestaña, se lanza un error: quien llama avisa y sugiere descargar el PDF.
 */

/** El texto del aviso cuando no se pudo abrir la impresión (ni el iframe ni la pestaña). */
export const PRINT_FAILED_MESSAGE =
  'No se pudo abrir la impresión: descarga el PDF desde «Más opciones» e imprímelo desde el archivo.';

/** Cuánto vive el iframe si el navegador nunca avisa que la impresión terminó. */
export const PRINT_CLEANUP_MS = 10 * 60_000;
/** Cuánto se espera a que el iframe cargue el PDF antes de probar con la pestaña nueva. */
export const PRINT_LOAD_TIMEOUT_MS = 20_000;

export interface PrintOptions {
  /**
   * Se llama una vez cuando el diálogo de impresión se cierra (`afterprint`). El visor de PDF de
   * algunos navegadores no lo avisa: quien necesite mover el foco lo hace también al resolver la
   * promesa, que es cuando el diálogo ya se pidió.
   */
  onAfterPrint?: () => void;
}

/** Los enlaces que se están preparando para imprimir: un doble clic no abre dos diálogos. */
const inFlight = new Set<string>();

/** El iframe de la última impresión: se quita al terminar o cuando empieza otra. */
let current: { cleanup: () => void } | null = null;

/**
 * Imprime `href` (una ruta `/api/...` que devuelve un PDF). Resuelve cuando el diálogo de
 * impresión ya se pidió; lanza `ApiError` si el API rechaza el archivo y `Error` si el navegador
 * no deja imprimir ni abrir la pestaña.
 */
export async function printFile(href: string, options: PrintOptions = {}): Promise<void> {
  if (inFlight.has(href)) return;
  inFlight.add(href);
  try {
    const res = await fetchFile(href, 'imprimir');
    const blob = await res.blob();
    await printBlob(blob, options);
  } finally {
    inFlight.delete(href);
  }
}

/** Carga `blob` en un iframe oculto y lo imprime. Exportada para los tests. */
export function printBlob(blob: Blob, { onAfterPrint }: PrintOptions = {}): Promise<void> {
  current?.cleanup();
  const url = URL.createObjectURL(blob);
  const frame = document.createElement('iframe');
  frame.title = 'Documento para imprimir';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // Sin `display: none`: un iframe que no se pinta no carga el visor de PDF en algunos navegadores.
  Object.assign(frame.style, {
    position: 'fixed',
    right: '0',
    bottom: '0',
    width: '0',
    height: '0',
    border: '0',
  });

  let cleaned = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    frame.remove();
    URL.revokeObjectURL(url);
    if (current?.cleanup === cleanup) current = null;
  };
  current = { cleanup };

  let notified = false;
  const afterPrint = (): void => {
    if (notified) return;
    notified = true;
    window.removeEventListener('afterprint', afterPrint);
    onAfterPrint?.();
    // Un respiro antes de quitar el iframe: algunos navegadores todavía leen el documento.
    cleanupTimer = setTimeout(cleanup, 1_000);
  };

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(loadTimer);
      if (err) {
        cleanup();
        reject(err);
        return;
      }
      cleanupTimer ??= setTimeout(cleanup, PRINT_CLEANUP_MS);
      resolve();
    };
    // La pestaña nueva imprime desde el visor del navegador; el iframe ya no hace falta, y el
    // blob se libera cuando la pestaña ya tuvo tiempo de leerlo.
    const fallbackToTab = (): void => {
      if (settled) return;
      const tab = window.open(url, '_blank');
      if (tab === null) {
        finish(new Error(PRINT_FAILED_MESSAGE));
        return;
      }
      notified = true;
      window.removeEventListener('afterprint', afterPrint);
      frame.remove();
      cleanupTimer = setTimeout(cleanup, 60_000);
      finish();
    };
    // `finish` la lee al terminar, que siempre es después de esta línea (el timer o el `load`).
    const loadTimer = setTimeout(fallbackToTab, PRINT_LOAD_TIMEOUT_MS);

    frame.addEventListener(
      'load',
      () => {
        const win = frame.contentWindow;
        try {
          if (win === null) throw new Error('El iframe no tiene ventana');
          win.addEventListener('afterprint', afterPrint, { once: true });
          window.addEventListener('afterprint', afterPrint, { once: true });
          win.focus();
          win.print();
        } catch {
          fallbackToTab();
          return;
        }
        finish();
      },
      { once: true },
    );
    frame.src = url;
    document.body.appendChild(frame);
  });
}
