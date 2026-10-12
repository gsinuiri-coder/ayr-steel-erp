import { describe, expect, it } from 'vitest';
import { downloadLabelFor } from './line-tabs';
import { WIDE_DIALOG_CLASSNAME } from './utils';

/** cc47b (D-623, D-625): rótulos de descarga por pestaña y el ancho de los modales de detalle. */
describe('cc47b', () => {
  it('D-623: el rótulo de la descarga dice la pestaña de línea que se ve', () => {
    expect(downloadLabelFor('Descargar Excel', 'drywall')).toBe('Descargar Excel · Drywall');
    expect(downloadLabelFor('Descargar PDF', 'metallic-roofing')).toBe(
      'Descargar PDF · Coberturas Aluzinc',
    );
    expect(downloadLabelFor('Descargar Excel', undefined)).toBe(
      'Descargar Excel · Todas las líneas',
    );
  });

  it('D-625: el modal de detalle llega al 90 % de la ventana y su contenido no lo estira', () => {
    expect(WIDE_DIALOG_CLASSNAME).toContain('sm:max-w-[min(90vw,90rem)]');
    expect(WIDE_DIALOG_CLASSNAME).toContain('[&>*]:min-w-0');
  });
});
