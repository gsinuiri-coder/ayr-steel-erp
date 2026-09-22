import type { LucideIcon } from 'lucide-react';
import {
  Banknote,
  Boxes,
  CalendarRange,
  ClipboardList,
  FileText,
  Hammer,
  History,
  Home,
  Layers,
  PackageSearch,
  Palette,
  Percent,
  ReceiptText,
  Scissors,
  ScrollText,
  ShoppingCart,
  Store,
  Send,
  Timer,
  TrendingUp,
  Truck,
  Users,
  UsersRound,
  Warehouse,
} from 'lucide-react';
import { Role, type RefTargetType } from '@ayr/shared';

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  roles: readonly Role[];
  /** Módulo aún no construido (fases siguientes). */
  soon?: boolean;
  /**
   * S10/M2: prefijo para marcar el ítem activo, cuando no coincide con `href` — un ítem
   * que apunta a la primera de varias rutas hermanas (pestañas) sigue "activo" en las
   * demás. Por defecto es `href`.
   */
  activePrefix?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

const ALL = [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA, Role.VENDEDOR] as const;

/**
 * Menú lateral por rol (§3.4). Los módulos de fases futuras se muestran deshabilitados.
 *
 * S10/M2: el orden y la agrupación son los que pidió el dueño — Comercial, Catálogo,
 * Planta, Administración —, sin la sección "General" de antes. "Panel" (antes "Inicio")
 * queda como el único ítem sin grupo (`label: ''`, que `app-sidebar.tsx` no pinta), a la
 * cabeza del menú. Ningún `href` cambió: es reordenar y renombrar, no mover rutas.
 */
export const NAV: NavGroup[] = [
  {
    label: '',
    items: [{ title: 'Panel', href: '/', icon: Home, roles: ALL }],
  },
  {
    label: 'Comercial',
    items: [
      {
        // Fase 7b (RF-60): primero de la lista porque es la pantalla que más se abre al
        // día, y la única que se usa de pie con una tablet en la mano.
        title: 'Mostrador',
        href: '/pos',
        icon: Store,
        roles: [Role.ADMINISTRADOR, Role.VENDEDOR],
      },
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
      },
      {
        // D-185: lo apartado mientras el cliente deposita, con su tiempo restante.
        title: 'Reservas temporales',
        href: '/reservas-temporales',
        icon: Timer,
        roles: [Role.ADMINISTRADOR, Role.VENDEDOR],
      },
      {
        title: 'Pedidos',
        href: '/pedidos',
        icon: ClipboardList,
        roles: [Role.ADMINISTRADOR, Role.VENDEDOR],
      },
      {
        title: 'Comprobantes',
        href: '/comprobantes',
        icon: ReceiptText,
        roles: [Role.ADMINISTRADOR, Role.VENDEDOR],
      },
      {
        title: 'Despachos',
        href: '/despachos',
        icon: Send,
        // El despacho es un acto de almacén (D-074): lo hace planta, no solo el vendedor.
        roles: [Role.ADMINISTRADOR, Role.VENDEDOR, Role.SUPERVISOR_PLANTA],
      },
      {
        title: 'Cobranzas',
        href: '/cobranzas',
        icon: Banknote,
        roles: [Role.ADMINISTRADOR, Role.VENDEDOR],
      },
    ],
  },
  {
    label: 'Catálogo',
    items: [
      { title: 'Líneas', href: '/lineas', icon: Layers, roles: ALL },
      { title: 'Acabados', href: '/acabados', icon: Palette, roles: ALL },
      { title: 'Catálogo', href: '/catalogo', icon: PackageSearch, roles: ALL },
      {
        title: 'Inventario',
        href: '/inventario',
        icon: Warehouse,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
      {
        title: 'Kardex',
        href: '/kardex',
        icon: ScrollText,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
      {
        title: 'Flejes',
        href: '/flejes',
        icon: Scissors,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
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
        title: 'Corte tercerizado',
        href: '/corte',
        icon: Scissors,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
      /*
        D-160: **dos** sitios de producción y no tres. D-155 había intentado distinguir la
        terminal del espacio del pedido por el nombre —"Producir un pedido" contra "Terminal
        de planta"—, pero el problema no era el rótulo: eran dos pantallas que hacían lo mismo
        con la mitad de las herramientas cada una. Se fundieron en `/planta`, que es la única
        entrada a **producir**; `/produccion` queda para **gestionar** las órdenes (costos,
        kardex y correcciones), que es lo que nunca se hace con guantes puestos.
      */
      {
        title: 'Producción',
        href: '/planta',
        icon: Hammer,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
      /*
        D-190: «Órdenes de producción» (`/produccion`) salió del menú. Producción se opera
        desde la cola y el workspace de `/planta`, las órdenes de un pedido se ven en su
        detalle y el historial completo es una sección de `/planta`. `/produccion` redirige.
      */
      {
        title: 'Proveedores',
        href: '/proveedores',
        icon: Truck,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
      {
        // D-124: el corte mensual que la fecha de operación hace posible.
        title: 'Reporte de bobinas',
        href: '/reportes/bobinas',
        icon: CalendarRange,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
    ],
  },
  {
    label: 'Administración',
    items: [
      {
        // RF-S4a/M1: van en Administración y no junto al reporte de bobinas porque llevan
        // costos en cada fila y son solo del administrador. La ruta del API dice lo mismo.
        title: 'Inventario valorizado',
        href: '/reportes/inventario-valorizado',
        icon: Boxes,
        roles: [Role.ADMINISTRADOR],
      },
      {
        // RF-S4a/M2.
        title: 'Ventas y margen',
        href: '/reportes/ventas-margen',
        icon: TrendingUp,
        roles: [Role.ADMINISTRADOR],
      },
      { title: 'Usuarios', href: '/usuarios', icon: Users, roles: [Role.ADMINISTRADOR] },
      {
        // S10/M2: Márgenes y tipo de cambio comparten pantalla (pestañas en
        // configuracion/layout.tsx); el ítem del menú apunta al primer tab.
        title: 'Márgenes, tipo de cambio y reservas',
        href: '/configuracion/margenes',
        activePrefix: '/configuracion',
        icon: Percent,
        roles: [Role.ADMINISTRADOR],
      },
      {
        // D-218/RF-S2/M3: visor unificado de auditoría, admin-only (RF-95).
        title: 'Auditoría',
        href: '/auditoria',
        icon: History,
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

/**
 * F8-S5/M1 (D-205, hallazgo de `revisor`): a qué rol le sirve de verdad el link que el
 * kardex arma a partir de `refTargetType`. `/kardex` lo ven los tres roles (línea 127 de
 * arriba), pero sus destinos son más angostos que eso —`/compras` y `/corte` son de
 * planta, `/pedidos` y `/comprobantes` son comerciales— así que sin este chequeo un
 * VENDEDOR o un SUPERVISOR_PLANTA llegaban a un link que su propio `RoleGate` de destino
 * rebota con "No tienes permiso para ver esta sección": no es una fuga (el API igual
 * exige el rol), pero sí un link que parece roto para dos de los tres roles que ahora ven
 * esta pantalla.
 *
 * `productionOrder` no sale de `NAV` porque `/produccion` no es un ítem de menú (D-190:
 * redirige, se opera desde `/planta`) — el par se copia a mano del `RoleGate` real de
 * `produccion-detalle-view.tsx`, y hay que mantenerlo si ese `RoleGate` cambia. Los demás
 * si vienen de `NAV`, para no repetir una lista que ya existe.
 */
function rolesOfNavItem(href: string): readonly Role[] {
  const item = NAV.flatMap((g) => g.items).find((i) => i.href === href);
  if (!item) throw new Error(`No hay ítem de NAV para "${href}"`);
  return item.roles;
}

export const REF_TARGET_ROLES: Record<RefTargetType, readonly Role[]> = {
  purchase: rolesOfNavItem('/compras'),
  cutting: rolesOfNavItem('/corte'),
  salesOrder: rolesOfNavItem('/pedidos'),
  productionOrder: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
};

/** El comprobante de una venta (D-205): mismos roles que `/comprobantes` en `NAV`. */
export const INVOICE_LINK_ROLES: readonly Role[] = rolesOfNavItem('/comprobantes');
