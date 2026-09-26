import { listOrderBy } from './list-sort';

/** D-323 — el orden por columna de un listado paginado, con desempate por el orden de siempre. */
describe('listOrderBy', () => {
  type K = 'code' | 'customer';
  const columns = {
    code: (dir: 'asc' | 'desc') => ({ seq: dir }),
    customer: (dir: 'asc' | 'desc') => ({ customer: { name: dir } }),
  };
  const fallback = [{ seq: 'desc' as const }];

  it('sin sort deja el orden por defecto', () => {
    expect(listOrderBy<K, object>({}, columns, fallback)).toEqual([{ seq: 'desc' }]);
  });

  it('con sort, la columna manda y el orden por defecto desempata; dir ausente es ascendente', () => {
    expect(listOrderBy<K, object>({ sort: 'customer' }, columns, fallback)).toEqual([
      { customer: { name: 'asc' } },
      { seq: 'desc' },
    ]);
    expect(listOrderBy<K, object>({ sort: 'code', dir: 'desc' }, columns, fallback)).toEqual([
      { seq: 'desc' },
      { seq: 'desc' },
    ]);
  });

  it('una clave que el listado no declara se ignora', () => {
    expect(listOrderBy<K, object>({ sort: 'otra' as K }, columns, fallback)).toEqual([
      { seq: 'desc' },
    ]);
  });

  it('no muta el orden por defecto que recibe', () => {
    const base = [{ seq: 'desc' as const }];
    listOrderBy<K, object>({ sort: 'customer', dir: 'desc' }, columns, base);
    expect(base).toEqual([{ seq: 'desc' }]);
  });
});
