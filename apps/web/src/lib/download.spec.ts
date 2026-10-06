import { describe, expect, it } from 'vitest';
import { downloadErrorMessage, filenameFromDisposition } from './download';

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

  it('sin mensaje legible, uno genérico con el código', async () => {
    expect(await downloadErrorMessage(new Response('<html>', { status: 502 }))).toBe(
      'No se pudo descargar el archivo (error 502)',
    );
  });
});
