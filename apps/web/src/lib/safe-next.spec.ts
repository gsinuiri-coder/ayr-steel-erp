import { describe, expect, it } from 'vitest';
import { safeNext, screenName } from './login-redirect';

/** cc31: a dónde vuelve el ingreso (ESPEC §7, sesión vencida). */
describe('vuelta después del ingreso', () => {
  it('solo acepta rutas propias', () => {
    expect(safeNext('/despachos/nuevo')).toBe('/despachos/nuevo');
    expect(safeNext(null)).toBe('/');
    expect(safeNext('https://otro.example')).toBe('/');
    expect(safeNext('//otro.example')).toBe('/');
    expect(safeNext('/\\otro.example')).toBe('/');
    expect(safeNext('/\t/otro.example')).toBe('/');
    expect(safeNext('/\n/otro.example')).toBe('/');
  });

  it('dice el nombre de la pantalla a la que vuelve', () => {
    expect(screenName('/despachos/nuevo')).toBe('Nuevo despacho');
    expect(screenName('/pedidos')).toBe('Pedidos');
    expect(screenName('/pedidos/0b6c7f1e-0000-4000-8000-000000000000')).toBe(
      'un documento de Pedidos',
    );
  });
});
