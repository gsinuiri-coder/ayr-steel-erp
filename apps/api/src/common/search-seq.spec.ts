import { searchSeqOf } from './search-seq';

/**
 * D-387 — el correlativo que el buscador de cotizaciones y de pedidos compara contra `seq`.
 * Un RUC de once dígitos no cabe en INT4: antes la lista respondía 500.
 */
describe('searchSeqOf', () => {
  it.each([
    ['COT-000123', 123],
    ['123', 123],
    ['PED-7', 7],
    ['2147483647', 2_147_483_647],
  ])('%s → %d', (search, expected) => {
    expect(searchSeqOf(search)).toBe(expected);
  });

  it.each([
    ['sin búsqueda', undefined],
    ['sin dígitos', 'Cliente'],
    ['un RUC de once dígitos', '20134615804'],
    ['un número que no cabe en INT4', '2147483648'],
  ])('%s → null', (_label, search) => {
    expect(searchSeqOf(search)).toBeNull();
  });
});
