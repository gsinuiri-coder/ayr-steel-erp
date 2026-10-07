import { describe, expect, it } from 'vitest';
import { Role } from '@ayr/shared';
import { filterGoTo, goToEntries, normalize } from './go-to';

/** cc31: «Ir a» (Ctrl K) ofrece pantallas y acciones de crear, filtradas por rol (ESPEC §2). */
describe('Ir a', () => {
  it('cada rol ve solo lo que puede abrir', () => {
    const seller = goToEntries(Role.VENDEDOR).map((e) => e.href);
    expect(seller).toContain('/cotizaciones');
    expect(seller).toContain('/cotizaciones/nueva');
    expect(seller).not.toContain('/bobinas');
    expect(seller).not.toContain('/compras/nueva');
    expect(seller).not.toContain('/clientes/nuevo');
    expect(seller).not.toContain('/usuarios');

    const plant = goToEntries(Role.SUPERVISOR_PLANTA).map((e) => e.href);
    expect(plant).toContain('/bobinas');
    expect(plant).toContain('/compras/nueva');
    expect(plant).toContain('/despachos/nuevo');
    expect(plant).not.toContain('/cotizaciones/nueva');

    const admin = goToEntries(Role.ADMINISTRADOR).map((e) => e.href);
    expect(admin).toContain('/usuarios');
    expect(admin).toContain('/catalogo/precios/importar');
  });

  it('busca sin tildes ni mayúsculas, en el título y en el grupo', () => {
    const all = goToEntries(Role.ADMINISTRADOR);
    expect(filterGoTo(all, 'bob').map((e) => e.title)).toEqual([
      'Bobinas',
      'Reporte mensual de bobinas',
      'Merma por bobina',
      'Nueva bobina desde XML',
    ]);
    expect(filterGoTo(all, 'cotizacion').map((e) => e.title)).toContain('Nueva cotización');
    expect(filterGoTo(all, 'nueva compra').map((e) => e.title)).toEqual(['Nueva compra']);
    expect(filterGoTo(all, 'almacen kardex').map((e) => e.title)).toEqual(['Kardex']);
    expect(filterGoTo(all, 'zzz')).toEqual([]);
    expect(filterGoTo(all, '   ')).toHaveLength(all.length);
  });

  it('normaliza tildes y mayúsculas', () => {
    expect(normalize('  Línea Órdenes ')).toBe('linea ordenes');
  });
});
