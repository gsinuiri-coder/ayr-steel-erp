import { describe, expect, it } from 'vitest';
import { filterRows } from './use-column-filters';

interface Row {
  sku: string;
  name: string;
}
const rows: Row[] = [
  { sku: 'BOB038AZUL', name: 'Bobina azul 0.38' },
  { sku: 'BOB038ROJO', name: 'Bobina rojo 0.38' },
  { sku: 'UPVC36MT', name: 'Plancha UPVC 3.6 m' },
  { sku: 'ACC-01', name: 'Cumbrera acanalada' },
];
const accessors = { sku: (r: Row) => r.sku, name: (r: Row) => r.name };

describe('filterRows (D-295)', () => {
  it('sin filtros o con filtros vacíos devuelve todas las filas', () => {
    expect(filterRows(rows, {}, accessors)).toHaveLength(4);
    expect(filterRows(rows, { sku: '  ', name: '' }, accessors)).toHaveLength(4);
  });

  it('filtra por «contiene», sin mayúsculas ni acentos', () => {
    expect(filterRows(rows, { sku: 'bob' }, accessors).map((r) => r.sku)).toEqual([
      'BOB038AZUL',
      'BOB038ROJO',
    ]);
    expect(filterRows(rows, { name: 'CUMBRERA ACANALADA' }, accessors)).toHaveLength(1);
    expect(filterRows(rows, { name: 'cumbrerá' }, accessors)).toHaveLength(1);
  });

  it('combina varias columnas con Y', () => {
    expect(filterRows(rows, { sku: 'bob', name: 'ROJO' }, accessors).map((r) => r.sku)).toEqual([
      'BOB038ROJO',
    ]);
    expect(filterRows(rows, { sku: 'bob', name: 'plancha' }, accessors)).toEqual([]);
  });
});
