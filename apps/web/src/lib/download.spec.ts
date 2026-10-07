import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { downloadErrorMessage, downloadFile, filenameFromDisposition } from './download';

/** cc28 (D-446): lo que la descarga por `fetch` lee de la respuesta del API. */
describe('descargas del API', () => {
  it('toma el nombre de filename* (UTF-8) antes que el de filename', () => {
    expect(
      filenameFromDisposition(
        `attachment; filename="comprobantes.xlsx"; filename*=UTF-8''comprobantes%20octubre.xlsx`,
      ),
    ).toBe('comprobantes octubre.xlsx');
    expect(filenameFromDisposition('attachment; filename="cotizaciones.xlsx"')).toBe(
      'cotizaciones.xlsx',
    );
    expect(filenameFromDisposition('attachment; filename=pedidos.xlsx')).toBe('pedidos.xlsx');
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition('inline')).toBeNull();
  });

  it('el 400 del tope sale con el mensaje del API', async () => {
    const res = new Response(
      JSON.stringify({
        statusCode: 400,
        message: 'La exportación tiene 6200 filas y el tope es 5000: acota los filtros.',
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
    expect(await downloadErrorMessage(res)).toBe(
      'La exportación tiene 6200 filas y el tope es 5000: acota los filtros.',
    );
  });

  it('sin mensaje legible, el motivo en español y sin el código', async () => {
    expect(await downloadErrorMessage(new Response('<html>', { status: 502 }))).toBe(
      'No se pudo descargar el archivo: el servidor no respondió.',
    );
    const generic = new Response(JSON.stringify({ message: 'Internal server error' }), {
      status: 500,
    });
    expect(await downloadErrorMessage(generic)).toBe(
      'No se pudo descargar el archivo: el servidor no respondió.',
    );
    expect(await downloadErrorMessage(new Response('', { status: 403 }))).toBe(
      'No tienes permiso para descargar este archivo.',
    );
    expect(await downloadErrorMessage(new Response('', { status: 404 }))).toBe(
      'No se encontró el archivo: puede que ya no exista.',
    );
    expect(await downloadErrorMessage(new Response('', { status: 429 }))).toMatch(
      /Espera un minuto/,
    );
  });

  it('un corte de red sale como «El servidor no respondió», no como «Failed to fetch»', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    try {
      const err: unknown = await downloadFile('/api/reports/x.xlsx').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(0);
      expect((err as ApiError).message).toBe('El servidor no respondió');
    } finally {
      globalThis.fetch = original;
    }
  });
});
