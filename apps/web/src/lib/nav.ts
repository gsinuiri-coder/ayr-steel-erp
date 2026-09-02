import type { LucideIcon } from 'lucide-react';
import {
  Banknote,
  Boxes,
  Factory,
  FileText,
  Home,
  Layers,
  PackageSearch,
  Palette,
  Percent,
  ReceiptText,
  ShoppingCart,
  Truck,
  Users,
  UsersRound,
} from 'lucide-react';
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
    label: 'Catálogo',
    items: [
      { title: 'Líneas', href: '/lineas', icon: Layers, roles: ALL },
      { title: 'Acabados', href: '/acabados', icon: Palette, roles: ALL },
      { title: 'Catálogo', href: '/catalogo', icon: PackageSearch, roles: ALL },
    ],
  },
  {
    label: 'Planta',
    items: [
      {
        title: 'Bobinas',
        href: '/bobinas',
        icon: Boxes,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
      {
        title: 'Compras',
        href: '/compras',
        icon: ShoppingCart,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
      {
        title: 'Producción',
        href: '/produccion',
        icon: Factory,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
        soon: true,
      },
      {
        title: 'Proveedores',
        href: '/proveedores',
        icon: Truck,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
    ],
  },
  {
    label: 'Comercial',
    items: [
      {
        title: 'Clientes',
        href: '/clientes',
        icon: UsersRound,
        roles: [Role.ADMINISTRADOR, Role.VENDEDOR],
      },
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
    items: [
      { title: 'Usuarios', href: '/usuarios', icon: Users, roles: [Role.ADMINISTRADOR] },
      {
        title: 'Márgenes',
        href: '/configuracion/margenes',
        icon: Percent,
        roles: [Role.ADMINISTRADOR],
      },
      {
        title: 'Tipo de cambio',
        href: '/configuracion/tipo-cambio',
        icon: Banknote,
        roles: [Role.ADMINISTRADOR],
      },
    ],
  },
];

export function navForRole(role: Role): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.roles.includes(role)) })).filter(
    (g) => g.items.length > 0,
  );
}
