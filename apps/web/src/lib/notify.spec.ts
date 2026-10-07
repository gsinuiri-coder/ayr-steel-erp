import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  ApiError,
  isClientError,
  SERVER_DOWN_MESSAGE,
  TOO_MANY_REQUESTS_MESSAGE,
} from './api';
import { errorMessage } from './notify';

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
}

/** cc31: el texto de un error, armado en un solo lugar (ESPEC §8, «Mensajes» y «Red»). */
describe('mensajes de error', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sin red, el API responde «El servidor no respondió» en vez de «Failed to fetch»', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = await api('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(SERVER_DOWN_MESSAGE);
    expect((err as ApiError).status).toBe(0);
  });

  it('un 500 genérico no dice «Error 500» ni el texto en inglés de Nest', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(respond(500, { statusCode: 500, message: 'Internal server error' })),
    );
    await expect(api('/x')).rejects.toThrow(SERVER_DOWN_MESSAGE);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(502)));
    await expect(api('/x')).rejects.toThrow(SERVER_DOWN_MESSAGE);
  });

  it('el motivo propio del API pasa tal cual, también en un 5xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond(400, { message: 'La cantidad supera lo pendiente' })),
    );
    await expect(api('/x')).rejects.toThrow('La cantidad supera lo pendiente');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond(503, { message: 'El PSE no contestó' })),
    );
    await expect(api('/x')).rejects.toThrow('El PSE no contestó');
  });

  it('el límite de intentos se dice en castellano', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond(429, { message: 'ThrottlerException: Too Many Requests' })),
    );
    await expect(api('/x')).rejects.toThrow(TOO_MANY_REQUESTS_MESSAGE);
  });

  it('un 4xx sin cuerpo no muestra «Error 404»', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(404)));
    const err = (await api('/x').catch((e: unknown) => e)) as ApiError;
    expect(err.message).not.toMatch(/^Error /);
  });

  it('un corte de red y un 5xx siguen siendo inciertos para la idempotencia (D-182)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const network = await api('/x').catch((e: unknown) => e);
    expect(isClientError(network)).toBe(false);
    expect(isClientError(new ApiError(502, SERVER_DOWN_MESSAGE))).toBe(false);
    expect(isClientError(new ApiError(409, 'Ya está anulado'))).toBe(true);
    expect(isClientError(new Error('x'))).toBe(false);
  });

  it('una petición cancelada no se convierte en «el servidor no respondió»', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The user aborted a request.', 'AbortError')),
    );
    const err = await api('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
  });

  it('un TypeError de un defecto del código no se disfraza de corte de red', () => {
    expect(
      errorMessage(
        new TypeError("Cannot read properties of undefined (reading 'map')"),
        'No se pudo',
      ),
    ).toBe('No se pudo');
    expect(
      errorMessage(new TypeError('NetworkError when attempting to fetch resource.'), 'x'),
    ).toBe(SERVER_DOWN_MESSAGE);
  });

  it('errorMessage usa el motivo del API, o el texto de respaldo para lo demás', () => {
    expect(errorMessage(new ApiError(409, 'Ya está anulado'), 'No se pudo anular')).toBe(
      'Ya está anulado',
    );
    expect(errorMessage(new TypeError('Failed to fetch'), 'No se pudo anular')).toBe(
      SERVER_DOWN_MESSAGE,
    );
    expect(errorMessage(new Error('boom'), 'No se pudo anular')).toBe('No se pudo anular');
    expect(errorMessage('x', 'No se pudo anular')).toBe('No se pudo anular');
  });
});
