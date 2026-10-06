import { describe, expect, it } from 'vitest';
import { listXlsxHref } from './list-export';

/** cc26 (D-provisional): el Excel lleva los filtros y el orden de la lista, sin paginar. */
describe('listXlsxHref', () => {
  it('copia filtros y orden, y quita page y pageSize', () => {
    const params = new URLSearchParams({ page: '3', pageSize: '100' });
    params.set('status', 'ISSUED,ACCEPTED');
    params.set('pendingOnly', 'true');
    params.set('search', 'Ñandú & cía');
    params.set('sort', 'total');
    params.set('dir', 'desc');
    const href = listXlsxHref('/invoicing/documents', params);
    const url = new URL(href, 'http://x');
    expect(url.pathname).toBe('/api/invoicing/documents/xlsx');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'ISSUED,ACCEPTED',
      pendingOnly: 'true',
      search: 'Ñandú & cía',
      sort: 'total',
      dir: 'desc',
    });
  });

  it('sin filtros, sin signo de interrogación', () => {
    expect(listXlsxHref('/sales/quotations', new URLSearchParams({ page: '1' }))).toBe(
      '/api/sales/quotations/xlsx',
    );
  });

  it('no toca los parámetros de la lista', () => {
    const params = new URLSearchParams({ page: '2', pageSize: '50' });
    listXlsxHref('/sales/quotations', params);
    expect(params.get('page')).toBe('2');
  });
});
