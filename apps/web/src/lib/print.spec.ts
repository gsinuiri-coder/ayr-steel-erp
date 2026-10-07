// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { PRINT_FAILED_MESSAGE, PRINT_LOAD_TIMEOUT_MS, printBlob, printFile } from './print';

/**
 * cc32: «Imprimir» pide el PDF con la misma puerta que la descarga, lo carga en un iframe oculto
 * y llama a su `print()`; nunca descarga el archivo. jsdom no imprime ni crea blobs: la ventana
 * del iframe y `URL.createObjectURL` se sustituyen por dobles.
 */

type FakeWindow = EventTarget & {
  print: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
};

let fakeWin: FakeWindow;
let contentWindow: PropertyDescriptor | undefined;
const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL.bind(URL);
const realRevoke = URL.revokeObjectURL.bind(URL);
const anchorClick = vi.fn();
const revoke = vi.fn();

function pdfResponse(): Response {
  return new Response('%PDF-1.4', {
    status: 200,
    headers: { 'content-type': 'application/pdf' },
  });
}

/** Espera a que el iframe esté en la página y le avisa que cargó, como haría el navegador. */
async function loadFrame(): Promise<HTMLIFrameElement> {
  const frame = await vi.waitFor(() => {
    const found = document.querySelector('iframe');
    if (found === null) throw new Error('todavía no hay iframe');
    return found;
  });
  frame.dispatchEvent(new Event('load'));
  return frame;
}

beforeEach(() => {
  fakeWin = Object.assign(new EventTarget(), { print: vi.fn(), focus: vi.fn() });
  contentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get: () => fakeWin,
  });
  URL.createObjectURL = vi.fn(() => 'blob:http://localhost/pdf');
  revoke.mockReset();
  URL.revokeObjectURL = revoke;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(anchorClick);
});

afterEach(() => {
  if (contentWindow) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', contentWindow);
  }
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
  globalThis.fetch = realFetch;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  anchorClick.mockReset();
});

describe('printFile', () => {
  it('carga el PDF en un iframe oculto e imprime sin descargarlo', async () => {
    const fetchMock = vi.fn().mockResolvedValue(pdfResponse());
    globalThis.fetch = fetchMock;
    const done = printFile('/api/invoicing/documents/1/pdf');
    const frame = await loadFrame();
    await done;

    expect(fetchMock).toHaveBeenCalledWith('/api/invoicing/documents/1/pdf', {
      credentials: 'include',
      cache: 'no-store',
    });
    expect(frame.getAttribute('src')).toBe('blob:http://localhost/pdf');
    expect(frame.getAttribute('aria-hidden')).toBeNull();
    expect(fakeWin.print).toHaveBeenCalledTimes(1);
    // Nada de `<a download>`: imprimir no deja un archivo en Descargas.
    expect(anchorClick).not.toHaveBeenCalled();
  });

  it('al cerrar la impresión avisa una sola vez y quita el iframe', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      globalThis.fetch = vi.fn().mockResolvedValue(pdfResponse());
      const onAfterPrint = vi.fn();
      const done = printFile('/api/x/pdf', { onAfterPrint });
      await loadFrame();
      await done;

      fakeWin.dispatchEvent(new Event('afterprint'));
      window.dispatchEvent(new Event('afterprint'));
      expect(onAfterPrint).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_000);
      expect(document.querySelector('iframe')).toBeNull();
      expect(revoke).toHaveBeenCalledWith('blob:http://localhost/pdf');
    } finally {
      vi.useRealTimers();
    }
  });

  it('un doble clic no pide el PDF dos veces', async () => {
    const fetchMock = vi.fn().mockResolvedValue(pdfResponse());
    globalThis.fetch = fetchMock;
    const first = printFile('/api/x/pdf');
    const second = printFile('/api/x/pdf');
    await second;
    await loadFrame();
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fakeWin.print).toHaveBeenCalledTimes(1);
  });

  it('con un 401 refresca la sesión y reintenta, como la descarga', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(pdfResponse());
    globalThis.fetch = fetchMock;
    const done = printFile('/api/x/pdf');
    await loadFrame();
    await done;
    expect(fetchMock.mock.calls.map((c) => c[0] as string)).toEqual([
      '/api/x/pdf',
      '/api/auth/refresh',
      '/api/x/pdf',
    ]);
    expect(fakeWin.print).toHaveBeenCalledTimes(1);
  });

  it('un rechazo del API sale con su mensaje en español y no imprime', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 404,
          message: 'El comprobante todavía no tiene ese archivo: se guarda cuando SUNAT lo acepta',
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    );
    const err: unknown = await printFile('/api/x/pdf').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    // Revisión de cc32: el 404 «sin archivo» también sale para un aceptado sin PDF (un manual, un
    // fallo de R2); el aviso no promete la aceptación.
    expect((err as ApiError).message).toBe(
      'Este documento no tiene un PDF guardado, así que no se puede imprimir. Abre el documento para ver su estado.',
    );
    expect(document.querySelector('iframe')).toBeNull();
    expect(fakeWin.print).not.toHaveBeenCalled();
  });

  it('sin motivo legible, el aviso habla de imprimir y no muestra el código', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<html>', { status: 502 }));
    const err: unknown = await printFile('/api/x/pdf').catch((e: unknown) => e);
    expect((err as ApiError).message).toBe(
      'No se pudo imprimir el archivo: el servidor no respondió.',
    );
  });

  it('si el navegador no deja imprimir el iframe, abre el PDF en una pestaña nueva', async () => {
    fakeWin.print.mockImplementation(() => {
      throw new Error('bloqueado');
    });
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    globalThis.fetch = vi.fn().mockResolvedValue(pdfResponse());
    const done = printFile('/api/x/pdf');
    await loadFrame();
    await done;
    expect(open).toHaveBeenCalledWith('blob:http://localhost/pdf', '_blank');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('si además bloquea la pestaña, falla con el mensaje que sugiere descargar', async () => {
    fakeWin.print.mockImplementation(() => {
      throw new Error('bloqueado');
    });
    vi.spyOn(window, 'open').mockReturnValue(null);
    globalThis.fetch = vi.fn().mockResolvedValue(pdfResponse());
    const done = printFile('/api/x/pdf').catch((e: unknown) => e);
    await loadFrame();
    const err = await done;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(PRINT_FAILED_MESSAGE);
    expect(document.querySelector('iframe')).toBeNull();
  });

  describe('dos impresiones seguidas y el respaldo a tiempo (revisión de cc32)', () => {
    beforeEach(() => {
      let n = 0;
      URL.createObjectURL = vi.fn(() => `blob:http://localhost/pdf-${String(++n)}`);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('la segunda cancela la primera: termina su promesa y su timer no abre un blob revocado', async () => {
      const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
      const first = printBlob(new Blob(['a']));
      // La primera nunca carga; empieza otra.
      const second = printBlob(new Blob(['b']));
      await first;
      expect(revoke).toHaveBeenCalledWith('blob:http://localhost/pdf-1');
      expect(document.querySelectorAll('iframe')).toHaveLength(1);

      document.querySelector('iframe')?.dispatchEvent(new Event('load'));
      await second;
      vi.advanceTimersByTime(PRINT_LOAD_TIMEOUT_MS * 2);
      expect(open).not.toHaveBeenCalled();
      expect(fakeWin.print).toHaveBeenCalledTimes(1);
    });

    it('cancelar quita el aviso de `afterprint` de la impresión anterior', async () => {
      const firstAfter = vi.fn();
      const first = printBlob(new Blob(['a']), { onAfterPrint: firstAfter });
      document.querySelector('iframe')?.dispatchEvent(new Event('load'));
      await first;
      void printBlob(new Blob(['b']), { onAfterPrint: vi.fn() });

      window.dispatchEvent(new Event('afterprint'));
      expect(firstAfter).not.toHaveBeenCalled();
    });

    it('si el iframe no carga, la pestaña se abre a los pocos segundos y, bloqueada, falla enseguida', async () => {
      expect(PRINT_LOAD_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
      vi.spyOn(window, 'open').mockReturnValue(null);
      const done = printBlob(new Blob(['a'])).catch((e: unknown) => e);
      vi.advanceTimersByTime(PRINT_LOAD_TIMEOUT_MS);
      const err = await done;
      expect((err as Error).message).toBe(PRINT_FAILED_MESSAGE);
      expect(document.querySelector('iframe')).toBeNull();
    });
  });

  it('el foco vuelve adonde estaba al pedir la impresión', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    // Imprimir le da el foco al iframe: el doble lo saca del botón, como el navegador.
    fakeWin.focus.mockImplementation(() => {
      button.blur();
    });
    const done = printBlob(new Blob(['a']));
    document.querySelector('iframe')?.dispatchEvent(new Event('load'));
    await done;
    expect(document.activeElement).toBe(button);
  });

  it('con `onAfterPrint`, el foco lo decide quien llama', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    fakeWin.focus.mockImplementation(() => {
      button.blur();
    });
    const done = printBlob(new Blob(['a']), { onAfterPrint: () => undefined });
    document.querySelector('iframe')?.dispatchEvent(new Event('load'));
    await done;
    expect(document.activeElement).not.toBe(button);
  });
});
