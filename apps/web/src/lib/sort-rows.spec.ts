import { describe, expect, it } from 'vitest';
import { sortRows } from './sort-rows';

/** D-323 — orden de columna sobre filas ya cargadas. */
interface Row {
  code: string;
  name: string;
  price: string;
}
const rows: Row[] = [
  { code: 'PED-10', name: 'Álamo', price: '9.5' },
  { code: 'PED-9', name: 'beta', price: '10' },
  { code: 'PED-2', name: '', price: '' },
];
const accessors = {
  code: { text: (r: Row) => r.code },
  name: { text: (r: Row) => r.name },
  price: { decimal: (r: Row) => r.price },
};

describe('sortRows', () => {
  it('sin columna elegida deja las filas como vienen (y no muta la entrada)', () => {
    const out = sortRows(rows, { key: null, dir: 'asc' }, accessors);
    expect(out.map((r) => r.code)).toEqual(['PED-10', 'PED-9', 'PED-2']);
    expect(out).not.toBe(rows);
  });

  it('el texto se ordena con los números por su valor: PED-9 antes que PED-10', () => {
    expect(sortRows(rows, { key: 'code', dir: 'asc' }, accessors).map((r) => r.code)).toEqual([
      'PED-2',
      'PED-9',
      'PED-10',
    ]);
    expect(sortRows(rows, { key: 'code', dir: 'desc' }, accessors).map((r) => r.code)).toEqual([
      'PED-10',
      'PED-9',
      'PED-2',
    ]);
  });

  it('sin distinguir acentos ni mayúsculas, y el vacío siempre al final', () => {
    expect(sortRows(rows, { key: 'name', dir: 'asc' }, accessors).map((r) => r.name)).toEqual([
      'Álamo',
      'beta',
      '',
    ]);
    expect(sortRows(rows, { key: 'name', dir: 'desc' }, accessors).map((r) => r.name)).toEqual([
      'beta',
      'Álamo',
      '',
    ]);
  });

  it('una clave que la tabla no declara (la URL la escribe cualquiera) deja las filas como llegan', () => {
    const out = sortRows(rows, { key: 'otra' as never, dir: 'asc' }, accessors);
    expect(out.map((r) => r.code)).toEqual(['PED-10', 'PED-9', 'PED-2']);
  });

  it('los decimales se comparan por valor, no como texto: 9.5 antes que 10', () => {
    expect(sortRows(rows, { key: 'price', dir: 'asc' }, accessors).map((r) => r.price)).toEqual([
      '9.5',
      '10',
      '',
    ]);
  });
});
