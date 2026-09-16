import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * D-219/RF-S2-CIERRE/M3: el argumento de D-219 —cada `audit.write(tx, …)` vive en la misma
 * transacción Prisma que la escritura de dominio que audita, así que un rollback se lleva la
 * fila de auditoría con él— es una lectura del código, no algo que el compilador fuerce:
 * `write(tx: AuditWriter, entry)` acepta cualquier objeto con la forma de
 * `PrismaClient`/`Prisma.TransactionClient`, y nada impide pasarle `this.prisma` (el cliente
 * global, fuera de cualquier transacción) por error — las dos formas tipan igual.
 *
 * Sin poder cambiar `AuditService` a un tipo nominal que distinga "cliente transaccional" de
 * "cliente global" (viviría de reescribir medio Prisma), el centinela verifica la única cosa
 * que sí se puede verificar desde el código fuente: **todo** `this.audit.write(` de un
 * servicio de dominio pasa literalmente `tx` como primer argumento — la convención que ya
 * sigue el código de punta a punta (censo: ~100 llamadas en ~30 archivos, ninguna excepción) —
 * y nunca `this.prisma` ni cualquier otro identificador.
 *
 * `this.audit.log(` es el atajo *no* transaccional, a propósito, para eventos sin una
 * escritura de dominio con la que alinearse (login/logout, y los tres eventos dirigidos por
 * el PSE en `invoicing.service.ts`/`purchases.service.ts`, documentados en D-219). Fuera de
 * esa lista blanca, un `audit.log(` en un servicio de dominio es la señal de que debería
 * haber usado `write(tx, …)` y no lo hizo.
 */
const SRC_ROOT = join(__dirname, '..');

const LOG_ALLOWLIST = new Set([
  'auth/auth.service.ts',
  'invoicing/invoicing.service.ts',
  'purchases/purchases.service.ts',
]);

function listServiceFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(abs).isDirectory()) {
      out.push(...listServiceFiles(abs, rel));
    } else if (entry.endsWith('.service.ts')) {
      out.push(rel);
    }
  }
  return out;
}

const SERVICE_FILES = listServiceFiles(SRC_ROOT);

describe('AuditService: toda escritura de dominio pasa por una transacción real (D-219)', () => {
  it('el censo de archivos *.service.ts no está vacío (si esto falla, se rompió el glob)', () => {
    expect(SERVICE_FILES.length).toBeGreaterThan(20);
  });

  it.each(SERVICE_FILES)(
    '%s: todo this.audit.write() pasa tx, nunca this.prisma ni otro cliente',
    (rel) => {
      const src = readFileSync(join(SRC_ROOT, rel), 'utf8');
      const calls = [...src.matchAll(/this\.audit\.write\(\s*([\w.]+)/g)];
      for (const m of calls) {
        expect(m[1]).toBe('tx');
      }
    },
  );

  it.each(SERVICE_FILES)(
    '%s: this.audit.log() (no transaccional) solo en la lista blanca',
    (rel) => {
      const usesLog = readFileSync(join(SRC_ROOT, rel), 'utf8').includes('this.audit.log(');
      if (!LOG_ALLOWLIST.has(rel)) {
        expect(usesLog).toBe(false);
      }
    },
  );

  it('la lista blanca de audit.log() sigue siendo exactamente esos archivos, ni más ni menos', () => {
    const withLog = SERVICE_FILES.filter((rel) =>
      readFileSync(join(SRC_ROOT, rel), 'utf8').includes('this.audit.log('),
    );
    expect(new Set(withLog)).toEqual(LOG_ALLOWLIST);
  });
});
