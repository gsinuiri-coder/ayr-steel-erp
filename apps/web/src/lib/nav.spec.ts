import { describe, expect, it } from 'vitest';
import { Role } from '@ayr/shared';
import { INVOICE_LINK_ROLES, NAV, REF_TARGET_ROLES, navForRole } from './nav';

/**
 * D-326 — el mapa del menú lateral por tarea (enmienda a D-175) y su filtro por rol (§3.4).
 */

const titles = (role: Role) =>
  Object.fromEntries(navForRole(role).map((g) => [g.label, g.items.map((i) => i.title)]));

describe('mapa del menú (D-326)', () => {
  it('los grupos van en este orden, con «Panel» suelto a la cabeza', () => {
    expect(NAV.map((g) => g.label)).toEqual([
      '',
      'Comercial',
      'Compras',
      'Almacén',
      'Planta',
      'Catálogo',
      'Reportes',
      'Administración',
    ]);
    expect(NAV[0]?.items.map((i) => i.title)).toEqual(['Panel']);
  });

  it('el administrador ve cada grupo con sus ítems, en el orden del mapa', () => {
    expect(titles(Role.ADMINISTRADOR)).toEqual({
      '': ['Panel'],
      Comercial: [
        'Cotizaciones',
        'Reservas temporales',
        'Pedidos',
        'Despachos',
        'Comprobantes',
        'Cobranzas',
        'Mostrador',
        'Clientes',
      ],
      Compras: ['Compras', 'Proveedores'],
      Almacén: ['Bobinas', 'Flejes', 'Corte tercerizado', 'Inventario', 'Kardex'],
      Planta: ['Producción', 'Órdenes de producción'],
      Catálogo: ['Productos', 'Líneas', 'Acabados', 'Colores'],
      Reportes: ['Ventas y margen', 'Inventario valorizado', 'Reporte mensual de bobinas'],
      Administración: ['Usuarios', 'Márgenes y tipo de cambio', 'Auditoría', 'Configuración'],
    });
  });

  it('el vendedor no ve compras, almacén, planta, reportes ni administración', () => {
    expect(Object.keys(titles(Role.VENDEDOR))).toEqual(['', 'Comercial', 'Catálogo']);
    expect(titles(Role.VENDEDOR)['Comercial']).toContain('Despachos');
    expect(titles(Role.VENDEDOR)['Comercial']).toContain('Cotizaciones');
  });

  it('planta ve almacén, compras, producción y el reporte mensual, y solo esos reportes', () => {
    const planta = titles(Role.SUPERVISOR_PLANTA);
    expect(planta['Reportes']).toEqual(['Reporte mensual de bobinas']);
    expect(planta['Planta']).toEqual(['Producción', 'Órdenes de producción']);
    expect(planta['Administración']).toBeUndefined();
    expect(planta['Comercial']).toEqual(['Despachos']);
  });

  it('ninguna ruta se repite salvo la pestaña de colores, que comparte /catalogo', () => {
    const hrefs = NAV.flatMap((g) => g.items.map((i) => i.href));
    const duplicated = hrefs.filter((h, i) => hrefs.indexOf(h) !== i);
    expect(duplicated).toEqual([]);
    expect(hrefs).toContain('/catalogo?tab=colores');
    expect(hrefs).toContain('/catalogo');
  });

  it('«Márgenes y tipo de cambio» sigue activo en las dos pestañas', () => {
    const item = NAV.flatMap((g) => g.items).find((i) => i.title === 'Márgenes y tipo de cambio');
    expect(item?.activePrefix).toEqual(['/configuracion/margenes', '/configuracion/tipo-cambio']);
  });

  it('los destinos que arma el kardex conservan sus roles', () => {
    expect(REF_TARGET_ROLES.purchase).toEqual([Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]);
    expect(REF_TARGET_ROLES.salesOrder).toEqual([Role.ADMINISTRADOR, Role.VENDEDOR]);
    expect(INVOICE_LINK_ROLES).toEqual([Role.ADMINISTRADOR, Role.VENDEDOR]);
  });
});
