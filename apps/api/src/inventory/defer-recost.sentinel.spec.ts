import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * cc58 (D-690, revisiones de cc58-d P3): `deferRecost` salta el recosteo de una escritura del kardex.
 * Solo lo puede usar quien recostea él mismo al final, con el estado completo. Hoy, solo la
 * corrección de fechas de D-374. Un llamador nuevo entra a esta lista con su motivo.
 */
const ALLOWED = new Set(['purchases/purchase-received-date-fix.ts']);
const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('spec.ts') ? [p] : [];
  });
}

describe('cc58 (D-690): quién difiere el recosteo', () => {
  it('solo la corrección de fechas de D-374, que recostea una vez al final', () => {
    const users = sources(SRC)
      .filter((p) => /deferRecost:\s*true/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(SRC, p).replace(/\\/g, '/'));
    expect(users).toEqual([...ALLOWED]);
    for (const file of ALLOWED) {
      expect(readFileSync(join(SRC, file), 'utf8')).toMatch(/recostForward\(/);
    }
  });
});
