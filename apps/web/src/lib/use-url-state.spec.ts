// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useColumnFilters } from './use-column-filters';
import { kardexCustomPatch } from './kardex-range';
import { useSort } from './use-sort';
import {
  URL_PAGINATION_DEFAULTS,
  useUrlPagination,
  useUrlSearchInput,
  useUrlState,
} from './use-url-state';

/**
 * D-289: el estado de las listas en la URL. `next/navigation` se sustituye por una URL de mentira
 * con las mismas reglas: `router.replace` cambia la query string y avisa a quien la lee. Con
 * `deferred` el cambio se aplica cuando el test lo dice, para reproducir la latencia de una
 * navegación real (el eco llega tarde).
 */
const nav = vi.hoisted(() => ({
  search: '',
  path: '/lista',
  deferred: false,
  pending: [] as (() => void)[],
  listeners: new Set<() => void>(),
  replaced: [] as string[],
}));

vi.mock('next/navigation', async () => {
  const { useMemo, useSyncExternalStore } = await import('react');
  const apply = (url: string) => {
    nav.search = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    nav.listeners.forEach((l) => {
      l();
    });
  };
  return {
    usePathname: () => nav.path,
    useRouter: () => ({
      replace: (url: string) => {
        nav.replaced.push(url);
        if (nav.deferred)
          nav.pending.push(() => {
            apply(url);
          });
        else apply(url);
      },
    }),
    useSearchParams: () => {
      const search = useSyncExternalStore(
        (listener) => {
          nav.listeners.add(listener);
          return () => nav.listeners.delete(listener);
        },
        () => nav.search,
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

const flush = () => {
  act(() => {
    const queue = nav.pending.splice(0);
    queue.forEach((apply) => {
      apply();
    });
  });
};

beforeEach(() => {
  nav.search = '';
  nav.deferred = false;
  nav.pending = [];
  nav.replaced = [];
  nav.listeners.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

const DEFAULTS = { ...URL_PAGINATION_DEFAULTS, search: '', status: '' };

describe('useUrlState', () => {
  it('sin parámetros devuelve los defaults, y lo que hay en la URL manda', () => {
    const empty = renderHook(() => useUrlState(DEFAULTS));
    expect(empty.result.current[0]).toEqual({ page: '1', pageSize: '50', search: '', status: '' });
    empty.unmount();
    nav.search = 'search=PED-1&page=3';
    const filled = renderHook(() => useUrlState(DEFAULTS));
    expect(filled.result.current[0]).toMatchObject({ search: 'PED-1', page: '3', status: '' });
    filled.unmount();
  });

  it('escribe con replace, conserva los parámetros ajenos y no escribe los defaults', () => {
    nav.search = 'historial=1';
    const { result, unmount } = renderHook(() => useUrlState(DEFAULTS));
    act(() => {
      result.current[1]({ status: 'CANCELLED' });
    });
    expect(nav.replaced.at(-1)).toBe('/lista?historial=1&status=CANCELLED');
    act(() => {
      result.current[1]({ status: '' });
    });
    expect(nav.replaced.at(-1)).toBe('/lista?historial=1');
    unmount();
  });

  it('un filtro nuevo vuelve a la página 1; la página sola y el orden, no', () => {
    nav.search = 'page=4';
    const { result, unmount } = renderHook(() =>
      useUrlState({ ...DEFAULTS, sort: '', dir: 'asc' }),
    );
    act(() => {
      result.current[1]({ sort: 'code', dir: 'desc' });
    });
    expect(nav.search).toContain('page=4');
    act(() => {
      result.current[1]({ status: 'CONFIRMED' });
    });
    expect(nav.search).not.toContain('page=');
    act(() => {
      result.current[1]({ status: 'DRAFT', page: '2' });
    });
    expect(nav.search).toContain('page=2');
    unmount();
  });

  it('con una función, cada parche parte de la URL más reciente (dos chips seguidos no se pisan)', () => {
    const { result, unmount } = renderHook(() => useUrlState({ stage: '' }));
    act(() => {
      result.current[1]((cur) => ({ stage: [cur.stage, 'FULFILLED'].filter(Boolean).join(',') }));
      result.current[1]((cur) => ({ stage: [cur.stage, 'CANCELLED'].filter(Boolean).join(',') }));
    });
    expect(new URLSearchParams(nav.search).get('stage')).toBe('FULFILLED,CANCELLED');
    unmount();
  });
});

describe('useUrlState — dos fechas escritas seguidas (kardex «Desde» y «Hasta»)', () => {
  const RANGE = { range: '', from: '', to: '' };
  const patch = (side: 'from' | 'to', value: string) => (cur: typeof RANGE) =>
    kardexCustomPatch(side, value, cur, { from: '2026-09-01', to: '2026-09-25' });

  it('con la navegación lenta, «Hasta» no pisa el «Desde» recién escrito', () => {
    nav.deferred = true;
    const { result, unmount } = renderHook(() => useUrlState(RANGE));
    act(() => {
      result.current[1](patch('from', '2026-08-01'));
      // La URL todavía no reflejó el primer cambio: el segundo parte de la más reciente.
      result.current[1](patch('to', '2026-08-31'));
    });
    flush();
    const params = new URLSearchParams(nav.search);
    expect(params.get('range')).toBe('custom');
    expect(params.get('from')).toBe('2026-08-01');
    expect(params.get('to')).toBe('2026-08-31');
    unmount();
  });

  it('dos parches sobre claves distintas, sin función, conservan los dos', () => {
    nav.deferred = true;
    const { result, unmount } = renderHook(() => useUrlState({ from: '', to: '' }));
    act(() => {
      result.current[1]({ from: '2026-08-01' });
      result.current[1]({ to: '2026-08-31' });
    });
    flush();
    expect(new URLSearchParams(nav.search).get('from')).toBe('2026-08-01');
    expect(new URLSearchParams(nav.search).get('to')).toBe('2026-08-31');
    unmount();
  });
});

describe('useUrlPagination', () => {
  it('lee página y tamaño de la URL y los escribe sin repetir los defaults', () => {
    nav.search = 'page=3&pageSize=100';
    const { result, unmount } = renderHook(() => {
      const [state, setState] = useUrlState(DEFAULTS);
      return useUrlPagination(state, setState);
    });
    expect(result.current).toMatchObject({ page: 3, pageSize: 100 });
    act(() => {
      result.current.setPageSize(25);
    });
    // Cambiar el tamaño vuelve a la página 1.
    expect(new URLSearchParams(nav.search).get('page')).toBeNull();
    expect(new URLSearchParams(nav.search).get('pageSize')).toBe('25');
    act(() => {
      result.current.setPage(2);
    });
    expect(new URLSearchParams(nav.search).get('page')).toBe('2');
    unmount();
  });

  it('un valor basura vale como el default', () => {
    nav.search = 'page=abc&pageSize=0';
    const { result, unmount } = renderHook(() => {
      const [state, setState] = useUrlState(DEFAULTS);
      return useUrlPagination(state, setState);
    });
    expect(result.current).toMatchObject({ page: 1, pageSize: 50 });
    unmount();
  });
});

describe('useSort (en la URL)', () => {
  it('el primer clic ordena ascendente, el segundo invierte y otra columna vuelve a ascendente', () => {
    const { result, unmount } = renderHook(() => useSort<'code' | 'total'>());
    expect(result.current[0]).toEqual({ key: null, dir: 'asc' });
    act(() => {
      result.current[1]('code');
    });
    expect(result.current[0]).toEqual({ key: 'code', dir: 'asc' });
    act(() => {
      result.current[1]('code');
    });
    expect(result.current[0]).toEqual({ key: 'code', dir: 'desc' });
    expect(nav.search).toBe('sort=code&dir=desc');
    act(() => {
      result.current[1]('total');
    });
    expect(result.current[0]).toEqual({ key: 'total', dir: 'asc' });
    unmount();
  });
});

describe('useUrlSearchInput', () => {
  const search = () =>
    renderHook(() => {
      const [state, setState] = useUrlState(DEFAULTS);
      const input = useUrlSearchInput(state.search, (v) => {
        setState({ search: v });
      });
      return { state, input };
    });

  it('el cuadro muestra lo tecleado al instante y la URL se actualiza al dejar de teclear', () => {
    vi.useFakeTimers();
    const { result, unmount } = search();
    act(() => {
      result.current.input[1]('  PED-9 ');
    });
    expect(result.current.input[0]).toBe('  PED-9 ');
    expect(nav.search).toBe('');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(new URLSearchParams(nav.search).get('search')).toBe('PED-9');
    unmount();
  });

  it('el eco atrasado de un commit propio no pisa lo que se sigue tecleando', () => {
    vi.useFakeTimers();
    nav.deferred = true;
    const { result, unmount } = search();
    act(() => {
      result.current.input[1]('ab');
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // La navegación de «ab» todavía no volvió; el usuario ya tecleó «abc».
    act(() => {
      result.current.input[1]('abc');
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(nav.pending).toHaveLength(2);
    nav.pending.splice(0, 1)[0]?.();
    act(() => {
      /* re-render con el eco de «ab» */
    });
    expect(result.current.input[0]).toBe('abc');
    flush();
    expect(result.current.input[0]).toBe('abc');
    expect(new URLSearchParams(nav.search).get('search')).toBe('abc');
    unmount();
  });

  it('un cambio externo de la URL (otro enlace, atrás) sí actualiza el cuadro', () => {
    const { result, unmount } = search();
    act(() => {
      nav.search = 'search=20512345678';
      nav.listeners.forEach((l) => {
        l();
      });
    });
    expect(result.current.input[0]).toBe('20512345678');
    unmount();
  });
});

describe('useColumnFilters', () => {
  it('filtra en el cliente por columna, combina con Y y se limpia', () => {
    const { result, unmount } = renderHook(() => useColumnFilters<'sku' | 'name'>());
    const rows = [
      { sku: 'A-1', name: 'Bobina azul' },
      { sku: 'B-2', name: 'Bobina roja' },
    ];
    const accessors = {
      sku: (r: (typeof rows)[number]) => r.sku,
      name: (r: (typeof rows)[number]) => r.name,
    };
    expect(result.current.hasActive).toBe(false);
    act(() => {
      result.current.setFilter('name', 'bobina');
      result.current.setFilter('sku', 'b-');
    });
    expect(result.current.hasActive).toBe(true);
    expect(result.current.apply(rows, accessors).map((r) => r.sku)).toEqual(['B-2']);
    act(() => {
      result.current.clear();
    });
    expect(result.current.apply(rows, accessors)).toHaveLength(2);
    unmount();
  });
});
