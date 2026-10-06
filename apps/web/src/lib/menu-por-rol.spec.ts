import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Role } from '@ayr/shared';
import { NAV, navForRole } from './nav';

/**
 * cc26 (D-439). `docs/manual/menu-por-rol.md` documenta qué entrada del menú ve cada rol. Este
 * test fija que la tabla del documento es exactamente `NAV`: las mismas entradas, en el mismo
 * orden y grupo, con la misma ruta y los mismos roles. Si cambia un rol en `NAV` y no el
 * documento (o al revés), falla.
 */

const DOC = resolve(__dirname, '../../../../docs/manual/menu-por-rol.md');
const ROLE_COLUMNS = [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA, Role.VENDEDOR] as const;

interface DocRow {
  group: string;
  title: string;
  href: string;
  roles: Role[];
}

function docMatrix(): DocRow[] {
  const text = readFileSync(DOC, 'utf8');
  const start = text.indexOf('<!-- matriz:inicio -->');
  const end = text.indexOf('<!-- matriz:fin -->');
  if (start < 0 || end < start) throw new Error('El documento perdió los marcadores de la matriz');
  return text
    .slice(start, end)
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .slice(2) // encabezado y separador
    .map((line) => {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      const [group = '', title = '', href = '', ...flags] = cells;
      return {
        group: group === '(suelto)' ? '' : group,
        title,
        href: href.replace(/`/g, ''),
        roles: ROLE_COLUMNS.filter((_, i) => {
          const flag = flags[i];
          if (flag !== 'Sí' && flag !== '—') throw new Error(`Celda de rol inválida: «${flag}»`);
          return flag === 'Sí';
        }),
      };
    });
}

describe('docs/manual/menu-por-rol.md (D-439)', () => {
  it('la matriz del documento es exactamente el mapa del menú', () => {
    const fromCode: DocRow[] = NAV.flatMap((g) =>
      g.items.map((i) => ({
        group: g.label,
        title: i.title,
        href: i.href,
        roles: ROLE_COLUMNS.filter((r) => i.roles.includes(r)),
      })),
    );
    expect(docMatrix()).toEqual(fromCode);
  });

  it('cada rol ve en el documento lo mismo que navForRole le da', () => {
    const rows = docMatrix();
    for (const role of ROLE_COLUMNS) {
      expect(rows.filter((r) => r.roles.includes(role)).map((r) => r.href)).toEqual(
        navForRole(role).flatMap((g) => g.items.map((i) => i.href)),
      );
    }
  });

  it('los conteos del documento son los del mapa: 32, 16 y 13 entradas', () => {
    const count = (role: Role) => navForRole(role).flatMap((g) => g.items).length;
    expect(count(Role.ADMINISTRADOR)).toBe(32);
    expect(count(Role.SUPERVISOR_PLANTA)).toBe(16);
    expect(count(Role.VENDEDOR)).toBe(13);
    expect(readFileSync(DOC, 'utf8')).toContain(
      'el administrador ve 32 entradas; el supervisor de planta, 16; el vendedor, 13.',
    );
  });
});
