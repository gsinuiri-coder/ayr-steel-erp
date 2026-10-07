import type { LucideIcon } from 'lucide-react';
import { Plus } from 'lucide-react';
import { Role } from '@ayr/shared';
import { navForRole } from '@/lib/nav';

/**
 * cc31: lo que ofrece «Ir a» (Ctrl K): las pantallas del menú y las acciones de crear, siempre
 * filtradas por el rol. Una entrada que el rol no puede abrir no aparece: llevarlo a «No tienes
 * permiso» es peor que no ofrecerla.
 */
export interface GoToEntry {
  kind: 'screen' | 'create';
  title: string;
  /** El grupo del menú donde vive («Almacén», «Compras»…); `Panel` no tiene. */
  group: string;
  href: string;
  icon: LucideIcon;
}

const SALES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;
const PLANT = [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA] as const;

/** Las pantallas de crear, con los mismos roles que el `RoleGate` de cada una. */
export const CREATE_ENTRIES: {
  title: string;
  group: string;
  href: string;
  roles: readonly Role[];
}[] = [
  { title: 'Nueva cotización', group: 'Comercial', href: '/cotizaciones/nueva', roles: SALES },
  { title: 'Nuevo pedido', group: 'Comercial', href: '/pedidos/nuevo', roles: SALES },
  {
    title: 'Nuevo despacho',
    group: 'Comercial',
    href: '/despachos/nuevo',
    roles: [Role.ADMINISTRADOR, Role.VENDEDOR, Role.SUPERVISOR_PLANTA],
  },
  { title: 'Nuevo comprobante', group: 'Comercial', href: '/comprobantes/nuevo', roles: SALES },
  {
    title: 'Nuevo cliente',
    group: 'Comercial',
    href: '/clientes/nuevo',
    roles: [Role.ADMINISTRADOR],
  },
  {
    title: 'Importar cotizaciones',
    group: 'Comercial',
    href: '/cotizaciones/importar',
    roles: [Role.ADMINISTRADOR],
  },
  { title: 'Nueva compra', group: 'Compras', href: '/compras/nueva', roles: PLANT },
  { title: 'Importar compras', group: 'Compras', href: '/compras/importar', roles: PLANT },
  { title: 'Nueva bobina desde XML', group: 'Almacén', href: '/bobinas/nueva-xml', roles: PLANT },
  { title: 'Nueva orden de corte', group: 'Almacén', href: '/corte/nueva', roles: PLANT },
  {
    title: 'Importar precios de lista',
    group: 'Catálogo',
    href: '/catalogo/precios/importar',
    roles: [Role.ADMINISTRADOR],
  },
];

export function goToEntries(role: Role): GoToEntry[] {
  const screens = navForRole(role).flatMap((g) =>
    g.items
      .filter((i) => !i.soon)
      .map((i): GoToEntry => ({
        kind: 'screen',
        title: i.title,
        group: g.label,
        href: i.href,
        icon: i.icon,
      })),
  );
  const creates = CREATE_ENTRIES.filter((c) => c.roles.includes(role)).map((c): GoToEntry => ({
    kind: 'create',
    title: c.title,
    group: c.group,
    href: c.href,
    icon: Plus,
  }));
  return [...screens, ...creates];
}

/** Minúsculas y sin tildes: «bobina» encuentra «Bobinas» y «cotizacion», «Nueva cotización». */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Las entradas que coinciden con lo escrito: todas las palabras tienen que aparecer en el título
 * o en el grupo. Primero las que empiezan por lo escrito y, dentro de cada tipo, en el orden del
 * menú.
 */
export function filterGoTo(entries: GoToEntry[], query: string): GoToEntry[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return entries;
  const first = words[0] ?? '';
  const matches = entries.filter((e) => {
    const haystack = normalize(`${e.title} ${e.group}`);
    return words.every((w) => haystack.includes(w));
  });
  const starts = (e: GoToEntry) => (normalize(e.title).startsWith(first) ? 0 : 1);
  return matches
    .map((e, i) => ({ e, i }))
    .sort((a, b) => starts(a.e) - starts(b.e) || a.i - b.i)
    .map(({ e }) => e);
}
