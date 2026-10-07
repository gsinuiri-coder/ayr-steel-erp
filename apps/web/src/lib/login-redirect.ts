import { crumbsFor } from '@/lib/breadcrumb';

function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * `next` solo si es una ruta propia: nada de `//otro-sitio`, barras invertidas ni caracteres de
 * control (un tabulador entre las barras, `/\t/otro-sitio`, el navegador lo quita y queda `//`).
 * Al final se resuelve contra un origen ficticio y tiene que seguir siendo ese origen.
 */
export function safeNext(next: string | null): string {
  if (!next?.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
  if (hasControlCharacter(next)) return '/';
  const base = 'http://ayr.invalid';
  return new URL(next, base).origin === base ? next : '/';
}

/** cc31: el nombre de la pantalla a la que se vuelve, para el aviso de sesión vencida. */
export function screenName(path: string): string | null {
  const crumbs = crumbsFor(path.split('?')[0] ?? path);
  if (crumbs.leaf && crumbs.leaf !== 'document') return crumbs.leaf.title;
  if (crumbs.leaf === 'document' && crumbs.list) return `un documento de ${crumbs.list.title}`;
  return crumbs.list?.title ?? null;
}
