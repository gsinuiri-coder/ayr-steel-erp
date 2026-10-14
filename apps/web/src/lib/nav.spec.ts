import { describe, expect, it } from 'vitest';
import { Role } from '@ayr/shared';
import { INVOICE_LINK_ROLES, NAV, OFF_MENU_SCREENS, REF_TARGET_ROLES, navForRole } from './nav';

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
      Planta: ['Producción'],
      Catálogo: ['Productos', 'Líneas', 'Acabados'],
      Reportes: [
        'Ventas y margen',
        'Ventas por material',
        'Cuentas por cobrar',
        'Inventario valorizado',
        'Reporte mensual de bobinas',
        'Merma por bobina',
        'Reporte de producción',
      ],
      Administración: ['Usuarios', 'Márgenes y tipo de cambio', 'Auditoría', 'Configuración'],
    });
  });

  it('el vendedor no ve compras, almacén, planta, reportes ni administración', () => {
    expect(Object.keys(titles(Role.VENDEDOR))).toEqual(['', 'Comercial', 'Catálogo']);
    expect(titles(Role.VENDEDOR).Comercial).toContain('Despachos');
    expect(titles(Role.VENDEDOR).Comercial).toContain('Cotizaciones');
  });

  it('planta ve almacén, compras, producción, el reporte mensual y el de producción, y solo esos reportes', () => {
    const planta = titles(Role.SUPERVISOR_PLANTA);
    expect(planta.Reportes).toEqual(['Reporte mensual de bobinas', 'Reporte de producción']);
    expect(planta.Planta).toEqual(['Producción']);
    expect(planta['Administración']).toBeUndefined();
    expect(planta.Comercial).toEqual(['Despachos']);
  });

  it('ninguna ruta se repite', () => {
    const hrefs = NAV.flatMap((g) => g.items.map((i) => i.href));
    const duplicated = hrefs.filter((h, i) => hrefs.indexOf(h) !== i);
    expect(duplicated).toEqual([]);
    expect(hrefs).toContain('/catalogo');
  });

  it('cc47 (D-612): órdenes de producción y colores salen del menú, con los mismos roles', () => {
    const hrefs = NAV.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).not.toContain('/produccion');
    expect(hrefs).not.toContain('/catalogo?tab=colores');
    expect(OFF_MENU_SCREENS.map((s) => [s.group, s.item.href, s.item.roles])).toEqual([
      ['Planta', '/produccion', [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]],
      [
        'Catálogo',
        '/catalogo?tab=colores',
        [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA, Role.VENDEDOR],
      ],
    ]);
    // Los roles que abren las órdenes llegan a Planta, donde está «Historial de órdenes»; los que
    // abren colores llegan a Catálogo, donde está su pestaña.
    const reach = (href: string) =>
      [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA, Role.VENDEDOR].filter((r) =>
        navForRole(r).some((g) => g.items.some((i) => i.href === href)),
      );
    expect(reach('/planta')).toEqual(OFF_MENU_SCREENS[0]?.item.roles);
    expect(reach('/catalogo')).toEqual(OFF_MENU_SCREENS[1]?.item.roles);
  });

  it('«Márgenes y tipo de cambio» sigue activo en las dos pestañas', () => {
    const item = NAV.flatMap((g) => g.items).find((i) => i.title === 'Márgenes y tipo de cambio');
    expect(item?.activePrefix).toEqual(['/configuracion/margenes', '/configuracion/tipo-cambio']);
  });

  it('los destinos que arma el kardex conservan sus roles', () => {
    expect(REF_TARGET_ROLES.purchase).toEqual([Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]);
    expect(REF_TARGET_ROLES.salesOrder).toEqual([Role.ADMINISTRADOR, Role.VENDEDOR]);
    expect(REF_TARGET_ROLES.salesReturn).toEqual([Role.ADMINISTRADOR, Role.VENDEDOR]);
    expect(INVOICE_LINK_ROLES).toEqual([Role.ADMINISTRADOR, Role.VENDEDOR]);
  });
});
