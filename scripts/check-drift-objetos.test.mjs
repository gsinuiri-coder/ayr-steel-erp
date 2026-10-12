import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_QUERIES,
  compareCatalogs,
  indexCatalog,
  looseDef,
  majorOf,
  normalizeDef,
  objectKey,
  referenceUrl,
} from './check-drift-objetos.mjs';

const check = (name, def) => ({ table: 'coils', name, def });
const base = () => ({
  constraint: [check('coils_status_ok', "CHECK ((status = 'ACTIVE'::text))")],
  trigger: [
    {
      table: 'coils',
      name: 'coils_color_from_finish',
      def: 'CREATE TRIGGER coils_color_from_finish BEFORE INSERT ON public.coils -- tgenabled=O',
    },
  ],
  function: [{ table: '', name: 'coil_color()', def: 'CREATE FUNCTION public.coil_color()' }],
  index: [
    {
      table: 'coils',
      name: 'coils_open_idx',
      def: "CREATE INDEX coils_open_idx ON public.coils (id) WHERE (status = 'OPEN')",
    },
  ],
  view: [],
});

test('normalizeDef solo quita CRLF y espacios al final de línea', () => {
  assert.equal(normalizeDef('BEGIN  \r\n  x := 1;\r\n'), 'BEGIN\n  x := 1;');
  // Revisión cc46 (P1): un literal en otras mayúsculas es otra regla.
  assert.notEqual(
    normalizeDef("CHECK (status = 'ACTIVE')"),
    normalizeDef("CHECK (status = 'Active')"),
  );
  assert.equal(looseDef("CHECK (status = 'ACTIVE')"), looseDef('check ("status"  = \'active\')'));
});

test('objectKey nombra la clase, la tabla y el objeto', () => {
  assert.equal(objectKey('constraint', check('x', '')), 'constraint coils.x');
  assert.equal(objectKey('function', { table: '', name: 'f(integer)' }), 'function f(integer)');
});

test('indexCatalog corta con una clave repetida', () => {
  assert.throws(
    () => indexCatalog({ constraint: [check('x', 'a'), check('x', 'b')] }),
    /Clave repetida/,
  );
});

test('compareCatalogs: iguales → ok, con los conteos por clase', () => {
  const result = compareCatalogs(base(), base());
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts.constraint, { reference: 1, production: 1 });
  assert.deepEqual(result.counts.index, { reference: 1, production: 1 });
});

test('compareCatalogs: lo que sobra, lo que falta y lo distinto', () => {
  const prod = base();
  prod.constraint.push(check('coils_hecho_a_mano', 'CHECK ((width_mm > 0))'));
  prod.function = [];
  prod.index[0] = { ...prod.index[0], def: `${prod.index[0].def} -- INVALID` };
  const result = compareCatalogs(base(), prod);
  assert.equal(result.ok, false);
  assert.deepEqual(result.onlyProduction, ['constraint coils.coils_hecho_a_mano']);
  assert.deepEqual(result.onlyReference, ['function coil_color()']);
  assert.deepEqual(
    result.changed.map((c) => [c.key, c.cosmetic]),
    [['index coils.coils_open_idx', false]],
  );
});

test('compareCatalogs: un trigger deshabilitado a mano es una diferencia real', () => {
  const prod = base();
  prod.trigger[0] = { ...prod.trigger[0], def: prod.trigger[0].def.replace('=O', '=D') };
  const [change] = compareCatalogs(base(), prod).changed;
  assert.equal(change?.key, 'trigger coils.coils_color_from_finish');
  assert.equal(change?.cosmetic, false);
});

test('compareCatalogs: una diferencia de solo mayúsculas se informa como cosmética', () => {
  const prod = base();
  prod.constraint[0] = check('coils_status_ok', "CHECK ((status = 'active'::text))");
  const result = compareCatalogs(base(), prod);
  assert.equal(result.ok, false);
  assert.equal(result.changed[0]?.cosmetic, true);
});

test('majorOf toma la versión mayor de server_version_num', () => {
  assert.equal(majorOf('180001'), 18);
  assert.equal(majorOf(170004), 17);
});

test('las consultas solo leen el catálogo de public y excluyen extensiones por clase', () => {
  for (const sql of Object.values(CATALOG_QUERIES)) {
    assert.match(sql, /public/);
    assert.match(sql, /d\.classid = 'pg_\w+'::regclass/);
    assert.match(sql, /deptype = 'e'/);
    assert.doesNotMatch(sql, /\b(insert|update|delete|alter|drop|create|truncate|grant)\b/i);
  }
  assert.match(CATALOG_QUERIES.trigger, /tgenabled/);
  assert.match(CATALOG_QUERIES.index, /indisvalid/);
  assert.match(CATALOG_QUERIES.constraint, /convalidated/);
});

test('la referencia es local y sin contraseña en la URL', () => {
  const url = new URL(referenceUrl());
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.password, '');
  assert.equal(url.pathname, '/ayr_drift_objetos');
});
