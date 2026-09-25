import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Centinela de D-286: el kardex es append-only también en la base, sin excepciones.
 *
 * La función del trigger `inventory_movements_immutable` la define la **última** migración que
 * la reescribe. D-285 abrió una puerta de un solo uso (cambiar `operation_date` de la carga
 * inicial con `ayr.opening_date_move`); D-286 la cerró. Si una migración nueva vuelve a abrir
 * algo —un `IF`, un `RETURN`, una variable de sesión—, este test falla y obliga a una decisión.
 */
const MIGRATIONS = resolve(__dirname, '../../prisma/migrations');
const STRICT_BODY = "RAISE EXCEPTION 'inventory_movements es append-only: no se permite %', TG_OP;";

function lastDefinition(): { migration: string; body: string } {
  const defining = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => ({
      migration: name,
      sql: readFileSync(resolve(MIGRATIONS, name, 'migration.sql'), 'utf8'),
    }))
    .filter((m) => /FUNCTION\s+inventory_movements_immutable\s*\(/.test(m.sql));
  const last = defining.at(-1);
  if (last === undefined) throw new Error('ninguna migración define la función del trigger');
  const body = /AS \$\$\s*BEGIN([\s\S]*?)END;\s*\$\$/.exec(last.sql)?.[1];
  if (body === undefined) throw new Error(`no se pudo leer el cuerpo en ${last.migration}`);
  return { migration: last.migration, body: body.trim() };
}

describe('kardex append-only en la base (D-286)', () => {
  it('la última definición del trigger rechaza todo UPDATE y DELETE, sin excepciones', () => {
    const { migration, body } = lastDefinition();
    expect(migration).toBe('20260925120000_kardex_append_only_estricto');
    expect(body).toBe(STRICT_BODY);
  });

  it('ninguna migración posterior a D-286 toca la función ni el trigger', () => {
    const later = readdirSync(MIGRATIONS)
      .filter((name) => name > '20260925120000_kardex_append_only_estricto')
      .filter((name) => !name.endsWith('.toml'))
      .filter((name) =>
        /inventory_movements_immutable|inventory_movements_no_update_delete/.test(
          readFileSync(resolve(MIGRATIONS, name, 'migration.sql'), 'utf8'),
        ),
      );
    expect(later).toEqual([]);
  });
});
