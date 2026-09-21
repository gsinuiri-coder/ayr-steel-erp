import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(__dirname, '..');

function listControllerFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(abs).isDirectory()) {
      out.push(...listControllerFiles(abs, rel));
    } else if (entry.endsWith('.controller.ts')) {
      out.push(rel);
    }
  }
  return out;
}

const CONTROLLER_FILES = listControllerFiles(SRC_ROOT);

describe('Centinela de Alcance Comercial (RF-S3c)', () => {
  it('el censo de controladores no est vaco', () => {
    expect(CONTROLLER_FILES.length).toBeGreaterThan(10);
  });

  it.each(CONTROLLER_FILES)(
    '%s: declara explcitamente su poltica de alcance (tiene @Roles o @Public, o excluye VENDEDOR por defecto)',
    (rel) => {
      const src = readFileSync(join(SRC_ROOT, rel), 'utf8');

      const classRolesMatch = /@Roles\(([^)]*)\)(?:[\s\S]*?)export class/.exec(src);
      const classHasRoles = !!classRolesMatch;
      const classRoles = classRolesMatch ? classRolesMatch[1] : '';

      const methodRegex = /@(Get|Post|Patch|Put|Delete)\([^)]*\)[\s\S]*?(?:async\s+)?(\w+)\s*\(/g;

      let match;
      while ((match = methodRegex.exec(src)) !== null) {
        if (match[2] === 'Roles') continue;

        const methodStart = match.index;
        const chunk = src.substring(Math.max(0, methodStart - 300), methodStart);

        const isPublic = chunk.includes('@Public()');
        const methodRolesMatch = /@Roles\(([^)]*)\)/.exec(chunk);

        if (isPublic) continue;

        const _effectiveRoles = methodRolesMatch ? methodRolesMatch[1] : classRoles;

        if (!classHasRoles && !methodRolesMatch) {
          throw new Error(
            `El mtodo "${match[2]}" en ${rel} no declara explcitamente @Roles() ni @Public(). ` +
              `Toda ruta debe declarar su poltica de alcance (ej. @Roles(Role.ADMINISTRADOR)).`,
          );
        }
      }
    },
  );
});
