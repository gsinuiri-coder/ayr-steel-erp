import { describe, expect, it } from 'vitest';
import { crumbsFor } from './breadcrumb';

/** cc31: la ruta de la barra superior (ESPEC §2). */
describe('ruta de la barra superior', () => {
  it('una lista es la pantalla actual, sin enlace', () => {
    expect(crumbsFor('/cotizaciones')).toEqual({
      group: 'Comercial',
      list: { title: 'Cotizaciones', href: null },
      leaf: null,
    });
  });

  it('un detalle enlaza a su lista y deja el código a la pantalla', () => {
    expect(crumbsFor('/cotizaciones/0b6c7f1e-0000-4000-8000-000000000000')).toEqual({
      group: 'Comercial',
      list: { title: 'Cotizaciones', href: '/cotizaciones' },
      leaf: 'document',
    });
    expect(crumbsFor('/bobinas/abc').group).toBe('Almacén');
  });

  it('una pantalla de crear lleva su título', () => {
    expect(crumbsFor('/despachos/nuevo')).toEqual({
      group: 'Comercial',
      list: { title: 'Despachos', href: '/despachos' },
      leaf: { title: 'Nuevo despacho' },
    });
    expect(crumbsFor('/compras/importar').leaf).toEqual({ title: 'Importar compras' });
    expect(crumbsFor('/proveedores/x/estado-cuenta').leaf).toEqual({ title: 'Estado de cuenta' });
    expect(crumbsFor('/pos/caja').leaf).toEqual({ title: 'Caja' });
  });

  it('las pestañas de configuración caen en su ítem', () => {
    expect(crumbsFor('/configuracion/tipo-cambio').list?.title).toBe('Márgenes y tipo de cambio');
  });

  it('el Panel no tiene grupo', () => {
    expect(crumbsFor('/')).toEqual({ group: '', list: { title: 'Panel', href: null }, leaf: null });
  });
});
