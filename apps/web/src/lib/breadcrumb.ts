import { CREATE_ENTRIES } from '@/lib/go-to';
import { NAV } from '@/lib/nav';

/**
 * cc31: la ruta de la barra superior —grupo / lista / documento— que reemplaza al botón
 * «Volver». Se arma de la URL y del menú (`NAV`), sin pedirle nada a cada pantalla salvo el
 * código del documento, que solo conoce el detalle (`useCrumbLabel`).
 */
export interface Crumbs {
  /** El grupo del menú («Comercial»); vacío para el Panel. */
  group: string;
  /** La pantalla de lista. `href` es `null` cuando es la pantalla actual. */
  list: { title: string; href: string | null } | null;
  /**
   * La hoja, si la pantalla está debajo de la lista: el título de una pantalla de crear o de
   * importar, o `'document'` para un detalle (el código lo pone la pantalla).
   */
  leaf: { title: string } | 'document' | null;
}

const EXTRA_LEAVES: Record<string, string> = {
  '/pos/caja': 'Caja',
  '/cambiar-contrasena': 'Cambiar contraseña',
};

/** El último tramo de la ruta es un id de documento (uuid). */
const ID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function crumbsFor(
  pathname: string,
  search: URLSearchParams = new URLSearchParams(),
): Crumbs {
  if (pathname === '/') return { group: '', list: { title: 'Panel', href: null }, leaf: null };
  if (pathname === '/cambiar-contrasena') {
    return { group: '', list: null, leaf: { title: 'Cambiar contraseña' } };
  }
  // El ítem del menú cuya ruta es el prefijo más largo de la pantalla actual. Un ítem con query
  // (`/catalogo?tab=colores`) solo cuenta si la pantalla tiene esa query, y entonces gana.
  let best: { group: string; title: string; path: string; prefix: string; score: number } | null =
    null;
  for (const g of NAV) {
    for (const item of g.items) {
      const query = [...new URLSearchParams(item.href.split('?')[1] ?? '').entries()];
      if (!query.every(([key, value]) => search.get(key) === value)) continue;
      const prefixes = item.activePrefix ?? item.href.split('?')[0] ?? item.href;
      for (const prefix of Array.isArray(prefixes) ? prefixes : [prefixes]) {
        const p = prefix as string;
        if (p === '/') continue;
        const score = p.length + query.length * 1000;
        if ((pathname === p || pathname.startsWith(`${p}/`)) && score > (best?.score ?? 0)) {
          best = {
            group: g.label,
            title: item.title,
            path: item.href,
            prefix: p,
            score,
          };
        }
      }
    }
  }
  if (!best) return { group: '', list: null, leaf: null };
  // La pantalla es el ítem (o una de sus pestañas hermanas, `activePrefix`).
  if (pathname === best.prefix) {
    return { group: best.group, list: { title: best.title, href: null }, leaf: null };
  }
  const list = { title: best.title, href: best.path };
  const create = CREATE_ENTRIES.find((c) => c.href === pathname);
  const extra = EXTRA_LEAVES[pathname];
  let leaf: Crumbs['leaf'] = null;
  if (create) leaf = { title: create.title };
  else if (extra) leaf = { title: extra };
  else if (pathname.endsWith('/importar')) leaf = { title: 'Importar' };
  else if (pathname.endsWith('/estado-cuenta')) leaf = { title: 'Estado de cuenta' };
  else if (pathname.endsWith('/editar')) leaf = { title: 'Editar cotización' };
  else if (pathname.endsWith('/agregar')) leaf = { title: 'Agregar ítems' };
  // Solo un id es un documento cuyo código pone la pantalla; cualquier otra subruta se queda con
  // la lista enlazada y sin hoja (nunca «…» para siempre).
  else if (ID_SEGMENT.test(pathname)) leaf = 'document';
  return { group: best.group, list, leaf };
}
