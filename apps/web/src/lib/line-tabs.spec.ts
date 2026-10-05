// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessLine, INVENTORY_VALUATION_LINES, COIL_REPORT_LINES } from '@ayr/shared';
import {
  ALL_LINES_TAB,
  lineTabHref,
  resolveLineTab,
  useLineTab,
  type LineTabsConfig,
} from './line-tabs';
import { useUrlState } from './use-url-state';

/**
 * cc23 (D-393..D-395). `next/navigation` se sustituye por un historial de mentira: `push` agrega
 * una entrada, `replace` pisa la actual y `back()` vuelve a la anterior, como el navegador.
 * «Refrescar» es desmontar y volver a montar la vista con la misma URL.
 */
const nav = vi.hoisted(() => ({
  path: '/reportes/ventas-margen',
  entries: [''] as string[],
  index: 0,
  pushed: [] as string[],
  replaced: [] as string[],
  listeners: new Set<() => void>(),
}));

function notify() {
  nav.listeners.forEach((l) => {
    l();
  });
}

function back() {
  act(() => {
    nav.index = Math.max(0, nav.index - 1);
    notify();
  });
}

vi.mock('next/navigation', async () => {
  const { useMemo, useSyncExternalStore } = await import('react');
  const searchOf = (url: string) => (url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
  return {
    usePathname: () => nav.path,
    useRouter: () => ({
      push: (url: string) => {
        nav.pushed.push(url);
        nav.entries = [...nav.entries.slice(0, nav.index + 1), searchOf(url)];
        nav.index = nav.entries.length - 1;
        notify();
      },
      replace: (url: string) => {
        nav.replaced.push(url);
        nav.entries[nav.index] = searchOf(url);
        notify();
      },
    }),
    useSearchParams: () => {
      const search = useSyncExternalStore(
        (listener) => {
          nav.listeners.add(listener);
          return () => nav.listeners.delete(listener);
        },
        () => nav.entries[nav.index] ?? '',
      );
      return useMemo(() => new URLSearchParams(search), [search]);
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderHook<T>(hook: () => T) {
  const result = { current: undefined as unknown as T };
  const Probe = () => {
    result.current = hook();
    return null;
  };
  const root = createRoot(document.createElement('div'));
  act(() => {
    root.render(createElement(Probe));
  });
  return {
    result,
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
  };
}

function current(): string {
  return nav.entries[nav.index] ?? '';
}

const SALES: LineTabsConfig = {
  lines: [
    BusinessLine.DRYWALL,
    BusinessLine.METALLIC_ROOFING,
    BusinessLine.ROOFING,
    BusinessLine.SERVICES,
    BusinessLine.TRADING,
  ],
  includeAll: true,
  keep: ['from', 'to'],
};

beforeEach(() => {
  nav.entries = [''];
  nav.index = 0;
  nav.pushed = [];
  nav.replaced = [];
  nav.listeners.clear();
});

describe('resolveLineTab', () => {
  it('sin parámetro es la pestaña por defecto: «Todas» si la hay, si no la primera línea', () => {
    expect(resolveLineTab(null, SALES)).toEqual({ tab: ALL_LINES_TAB, valid: true });
    expect(resolveLineTab(null, { lines: COIL_REPORT_LINES, includeAll: false })).toEqual({
      tab: BusinessLine.DRYWALL,
      valid: true,
    });
  });

  it('una línea del reporte es válida', () => {
    expect(resolveLineTab('roofing', SALES)).toEqual({ tab: 'roofing', valid: true });
  });

  it('una línea inexistente, una sin este reporte o la de defecto escrita cae al defecto', () => {
    expect(resolveLineTab('acero', SALES)).toEqual({ tab: ALL_LINES_TAB, valid: false });
    // D-394: Servicios no tiene inventario valorizado.
    expect(
      resolveLineTab('services', { lines: INVENTORY_VALUATION_LINES, includeAll: true }),
    ).toEqual({ tab: ALL_LINES_TAB, valid: false });
    expect(resolveLineTab('todas', SALES)).toEqual({ tab: ALL_LINES_TAB, valid: false });
    expect(resolveLineTab('', SALES)).toEqual({ tab: ALL_LINES_TAB, valid: false });
  });
});

describe('lineTabHref', () => {
  it('conserva los filtros comunes, descarta los demás y no escribe la pestaña por defecto', () => {
    const qs = new URLSearchParams('from=2026-09-01&to=2026-09-30&tipo=PLANCHA&linea=drywall');
    expect(lineTabHref('/r', qs, 'trading', SALES)).toBe(
      '/r?from=2026-09-01&to=2026-09-30&linea=trading',
    );
    expect(lineTabHref('/r', qs, ALL_LINES_TAB, SALES)).toBe('/r?from=2026-09-01&to=2026-09-30');
    expect(lineTabHref('/r', new URLSearchParams(), ALL_LINES_TAB, SALES)).toBe('/r');
  });
});

describe('useLineTab', () => {
  it('cambiar de pestaña entra al historial y retroceder vuelve a la anterior', () => {
    nav.entries = ['from=2026-09-01&to=2026-09-30'];
    const { result, unmount } = renderHook(() => useLineTab(SALES));
    expect(result.current.tab).toBe(ALL_LINES_TAB);
    expect(result.current.line).toBeUndefined();

    act(() => {
      result.current.select(BusinessLine.DRYWALL);
    });
    expect(nav.pushed).toEqual([
      '/reportes/ventas-margen?from=2026-09-01&to=2026-09-30&linea=drywall',
    ]);
    expect(result.current.tab).toBe(BusinessLine.DRYWALL);
    expect(result.current.line).toBe(BusinessLine.DRYWALL);

    act(() => {
      result.current.select(BusinessLine.SERVICES);
    });
    expect(result.current.tab).toBe(BusinessLine.SERVICES);

    back();
    expect(result.current.tab).toBe(BusinessLine.DRYWALL);
    back();
    expect(result.current.tab).toBe(ALL_LINES_TAB);
    expect(current()).toBe('from=2026-09-01&to=2026-09-30');
    expect(nav.replaced).toEqual([]);
    unmount();
  });

  it('elegir la pestaña en la que ya se está no apila historial', () => {
    nav.entries = ['linea=roofing'];
    const { result, unmount } = renderHook(() => useLineTab(SALES));
    act(() => {
      result.current.select(BusinessLine.ROOFING);
    });
    expect(nav.pushed).toEqual([]);
    unmount();
  });

  it('refrescar vuelve a la misma pestaña con los mismos filtros', () => {
    nav.entries = ['from=2026-08-01&to=2026-08-31&linea=metallic-roofing'];
    const first = renderHook(() => useLineTab(SALES));
    expect(first.result.current.tab).toBe(BusinessLine.METALLIC_ROOFING);
    first.unmount();
    const again = renderHook(() => ({
      tabs: useLineTab(SALES),
      url: useUrlState({ from: '', to: '' })[0],
    }));
    expect(again.result.current.tabs.tab).toBe(BusinessLine.METALLIC_ROOFING);
    expect(again.result.current.url).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(nav.replaced).toEqual([]);
    again.unmount();
  });

  it('una línea inválida en la URL cae a la pestaña por defecto y corrige la URL sin apilar', () => {
    nav.entries = ['from=2026-09-01&linea=acero'];
    const { result, unmount } = renderHook(() => useLineTab(SALES));
    expect(result.current.tab).toBe(ALL_LINES_TAB);
    expect(nav.replaced).toEqual(['/reportes/ventas-margen?from=2026-09-01']);
    expect(nav.pushed).toEqual([]);
    expect(current()).toBe('from=2026-09-01');
    unmount();
  });

  it('una línea sin este reporte (Servicios en inventario) también se corrige', () => {
    nav.path = '/reportes/inventario-valorizado';
    nav.entries = ['linea=services'];
    const { result, unmount } = renderHook(() =>
      useLineTab({ lines: INVENTORY_VALUATION_LINES, includeAll: true }),
    );
    expect(result.current.tab).toBe(ALL_LINES_TAB);
    expect(nav.replaced).toEqual(['/reportes/inventario-valorizado']);
    nav.path = '/reportes/ventas-margen';
    unmount();
  });
});
