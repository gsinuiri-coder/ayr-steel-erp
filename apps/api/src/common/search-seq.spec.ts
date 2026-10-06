import { searchSeqOf } from './search-seq';

/**
 * D-387 y cc28 (D-462) — el correlativo que el buscador de cotizaciones y de pedidos compara contra
 * `seq`. Un RUC de once dígitos no cabe en INT4 (antes la lista respondía 500), y un texto con
 * forma de comprobante no es un código interno (P2-1 de cc19).
 */
describe('searchSeqOf', () => {
  it.each([
    ['COT-000123', 'COT', 123],
    ['cot 123', 'COT', 123],
    ['123', 'COT', 123],
    [' 0042 ', 'PED', 42],
    ['PED-7', 'PED', 7],
    ['2147483647', 'COT', 2_147_483_647],
  ] as const)('%s (%s) → %d', (search, prefix, expected) => {
    expect(searchSeqOf(search, prefix)).toBe(expected);
  });

  it.each([
    ['sin búsqueda', undefined, 'COT'],
    ['sin dígitos', 'Cliente', 'COT'],
    ['un RUC de once dígitos', '20134615804', 'COT'],
    ['un número que no cabe en INT4', '2147483648', 'COT'],
    // P2-1 de cc19: un comprobante no es el correlativo de una cotización ni de un pedido.
    ['un comprobante', 'BBV1-347', 'COT'],
    ['un comprobante con espacios', 'FFA1 - 1419', 'PED'],
    ['el prefijo del otro documento', 'PED-12', 'COT'],
    ['texto con dígitos', 'Obra 2025', 'COT'],
  ] as const)('%s → null', (_label, search, prefix) => {
    expect(searchSeqOf(search, prefix)).toBeNull();
  });
});
