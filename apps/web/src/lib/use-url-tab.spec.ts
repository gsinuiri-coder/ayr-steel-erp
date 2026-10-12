import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * cc47 (D-617): la pestaña de una página con más de una tabla vive en la URL. Se prueba el hook
 * sin DOM: `next/navigation` y `useCallback` se reemplazan por dobles (el router solo registra lo
 * que se le pide).
 */
const push = vi.fn();
let search = new URLSearchParams();

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useCallback: <T>(fn: T) => fn,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/cobranzas',
  useSearchParams: () => search,
}));

const { useUrlTab } = await import('./use-url-tab');
const TABS = ['cliente', 'pendientes'] as const;

describe('useUrlTab (cc47, D-617)', () => {
  beforeEach(() => {
    push.mockReset();
    search = new URLSearchParams();
  });

  it('sin parámetro, la pestaña es la de defecto', () => {
    expect(useUrlTab(TABS, 'cliente')[0]).toBe('cliente');
  });

  it('lee la pestaña de la URL; un valor que no es pestaña cae en la de defecto', () => {
    search = new URLSearchParams('tab=pendientes');
    expect(useUrlTab(TABS, 'cliente')[0]).toBe('pendientes');
    search = new URLSearchParams('tab=otra');
    expect(useUrlTab(TABS, 'cliente')[0]).toBe('cliente');
  });

  it('cambiar de pestaña entra al historial y conserva los demás parámetros', () => {
    search = new URLSearchParams('pPage=2&search=F001');
    const [, select] = useUrlTab(TABS, 'cliente');
    select('pendientes');
    expect(push).toHaveBeenCalledWith('/cobranzas?pPage=2&search=F001&tab=pendientes', {
      scroll: false,
    });
  });

  it('la pestaña de defecto no se escribe (URL limpia)', () => {
    search = new URLSearchParams('tab=pendientes');
    const [, select] = useUrlTab(TABS, 'cliente');
    select('cliente');
    expect(push).toHaveBeenCalledWith('/cobranzas', { scroll: false });
  });

  it('acepta otro nombre de parámetro', () => {
    search = new URLSearchParams('tabla=productos&line=roofing');
    const [tab, select] = useUrlTab(['bobinas', 'productos'] as const, 'bobinas', 'tabla');
    expect(tab).toBe('productos');
    select('bobinas');
    expect(push).toHaveBeenCalledWith('/cobranzas?line=roofing', { scroll: false });
  });
});
