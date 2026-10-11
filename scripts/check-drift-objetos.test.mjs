import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_QUERIES,
  compareCatalogs,
  majorOf,
  normalizeDef,
  objectKey,
  referenceUrl,
} from './check-drift-objetos.mjs';

const check = (name, def) => ({ table: 'coils', name, def });
const base = () => ({
  constraint: [check('coils_weight_positive', 'CHECK ((weight_kg > (0)::numeric))')],
  trigger: [
    {
      table: 'coils',
      name: 'coils_color_from_finish',
      def: 'CREATE TRIGGER coils_color_from_finish BEFORE INSERT ON public.coils',
    },
  ],
  function: [{ table: '', name: 'coil_color()', def: 'CREATE FUNCTION public.coil_color()' }],
  index: [],
  view: [],
});

test('normalizeDef ignora comillas, mayúsculas y espacios', () => {
  assert.equal(
    normalizeDef('CHECK ("weight_kg"  >\n (0)::numeric)'),
    normalizeDef('check (weight_kg > (0)::NUMERIC)'),
  );
  assert.notEqual(normalizeDef('CHECK (a > 0)'), normalizeDef('CHECK (a >= 0)'));
});

test('objectKey nombra la clase, la tabla y el objeto', () => {
  assert.equal(objectKey('constraint', check('x', '')), 'constraint coils.x');
  assert.equal(objectKey('function', { table: '', name: 'f(integer)' }), 'function f(integer)');
});

test('compareCatalogs: iguales salvo texto → ok', () => {
  const prod = base();
  prod.constraint[0] = check('coils_weight_positive', 'CHECK (("weight_kg" > (0)::NUMERIC))');
  const result = compareCatalogs(base(), prod);
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts.constraint, { reference: 1, production: 1 });
});

test('compareCatalogs: lo que sobra, lo que falta y lo distinto', () => {
  const prod = base();
  prod.constraint.push(check('coils_hecho_a_mano', 'CHECK ((width_mm > 0))'));
  prod.trigger = [];
  prod.function[0] = { ...prod.function[0], def: 'CREATE FUNCTION public.coil_color() -- otra' };
  const result = compareCatalogs(base(), prod);
  assert.equal(result.ok, false);
  assert.deepEqual(result.onlyProduction, ['constraint coils.coils_hecho_a_mano']);
  assert.deepEqual(result.onlyReference, ['trigger coils.coils_color_from_finish']);
  assert.deepEqual(
    result.changed.map((c) => c.key),
    ['function coil_color()'],
  );
});

test('majorOf toma la versión mayor de server_version_num', () => {
  assert.equal(majorOf('180001'), 18);
  assert.equal(majorOf(170004), 17);
});

test('las consultas solo leen el catálogo del esquema public y excluyen extensiones', () => {
  for (const sql of Object.values(CATALOG_QUERIES)) {
    assert.match(sql, /public/);
    assert.match(sql, /deptype = 'e'/);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
  }
});

test('la referencia es local y sin contraseña en la URL', () => {
  const url = new URL(referenceUrl());
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.password, '');
  assert.equal(url.pathname, '/ayr_drift_objetos');
});
