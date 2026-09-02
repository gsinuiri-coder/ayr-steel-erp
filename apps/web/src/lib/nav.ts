import type { LucideIcon } from 'lucide-react';
import { Boxes, Factory, FileText, Home, ReceiptText, Users } from 'lucide-react';
import { Role } from '@ayr/shared';

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  roles: readonly Role[];
  /** Módulo aún no construido (fases siguientes). */
  soon?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

const ALL = [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA, Role.VENDEDOR] as const;

/** Menú lateral por rol (§3.4). Los módulos de fases futuras se muestran deshabilitados. */
export const NAV: NavGroup[] = [
  {
    label: 'General',
    items: [{ title: 'Inicio', href: '/', icon: Home, roles: ALL }],
  },
  {
    label: 'Planta',
    items: [
      {
        title: 'Bobinas',
        href: '/bobinas',
        icon: Boxes,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
        soon: true,
      },
      {
        title: 'Producción',
        href: '/produccion',
        icon: Factory,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
        soon: true,
      },
    ],
  },
  {
    label: 'Comercial',
    items: [
      {
        title: 'Cotizaciones',
        href: '/cotizaciones',
        icon: FileText,
        roles: [Role.ADMINISTRADOR, Role.VENDEDOR],
        soon: true,
      },
      {
        title: 'Ventas',
        href: '/ventas',
        icon: ReceiptText,
        roles: [Role.ADMINISTRADOR, Role.VENDEDOR],
        soon: true,
      },
    ],
  },
  {
    label: 'Administración',
    items: [{ title: 'Usuarios', href: '/usuarios', icon: Users, roles: [Role.ADMINISTRADOR] }],
  },
];

export function navForRole(role: Role): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.roles.includes(role)) })).filter(
    (g) => g.items.length > 0,
  );
}
