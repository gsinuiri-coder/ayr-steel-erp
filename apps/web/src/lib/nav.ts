import type { LucideIcon } from 'lucide-react';
import {
  Banknote,
  Boxes,
  CalendarRange,
  ClipboardList,
  Coins,
  FileText,
  Hammer,
  History,
  Home,
  Layers,
  PackageSearch,
  Paintbrush,
  Palette,
  Percent,
  ReceiptText,
  Scissors,
  ScrollText,
  Settings,
  ShieldCheck,
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
  activePrefix?: string | readonly string[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

const ALL = [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA, Role.VENDEDOR] as const;

/**
 * Menú lateral por rol (§3.4). Los módulos de fases futuras se muestran deshabilitados.
 *
 * D-326 (enmienda a D-175, decisión del dueño, correcciones 04): los grupos son Comercial,
 * Compras, Almacén, Planta, Catálogo, Reportes y Administración, con «Panel» suelto a la cabeza
 * (`label: ''`, que `app-sidebar.tsx` no pinta). Cada grupo responde a una tarea: vender,
 * comprar, guardar y mover material, producir, mantener el maestro, mirar reportes y administrar.
 * Ningún `href` cambió: es mover ítems entre grupos, no rutas. El único ítem que el mapa del
 * dueño no nombraba, «Reservas temporales» (D-185), se queda en Comercial junto a Cotizaciones,
 * que es de donde salen.
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
        title: 'Despachos',
        href: '/despachos',
        icon: Send,
        // El despacho es un acto de almacén (D-074): lo hace planta, no solo el vendedor.
        roles: [Role.ADMINISTRADOR, Role.VENDEDOR, Role.SUPERVISOR_PLANTA],
      },
      {
        title: 'Comprobantes',
        href: '/comprobantes',
        icon: ReceiptText,
        roles: [Role.ADMINISTRADOR, Role.VENDEDOR],
      },
      {
        title: 'Cobranzas',
        href: '/cobranzas',
        icon: Banknote,
        roles: [Role.ADMINISTRADOR, Role.VENDEDOR],
      },
      {
        // Fase 7b (RF-60): la única pantalla que se usa de pie con una tablet en la mano.
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
    ],
  },
  {
    label: 'Compras',
    items: [
      {
        title: 'Compras',
        href: '/compras',
        icon: ShoppingCart,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
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
    label: 'Almacén',
    items: [
      {
        title: 'Bobinas',
        href: '/bobinas',
        icon: Boxes,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
      {
        title: 'Flejes',
        href: '/flejes',
        icon: Scissors,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
      {
        title: 'Corte tercerizado',
        href: '/corte',
        icon: Scissors,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
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
    ],
  },
  {
    label: 'Planta',
    items: [
      /*
        D-160: **dos** sitios de producción y no tres: `/planta` es la única entrada a
        **producir** y `/produccion` sirve para **gestionar** las órdenes (historial, costos y
        correcciones). D-190 sacó «Órdenes de producción» del menú; D-326 lo devuelve porque el
        cliente lo pidió en su mapa — `/produccion` redirige al historial de `/planta`.
      */
      {
        title: 'Producción',
        href: '/planta',
        icon: Hammer,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
      {
        title: 'Órdenes de producción',
        href: '/produccion',
        icon: History,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
    ],
  },
  {
    label: 'Catálogo',
    items: [
      { title: 'Productos', href: '/catalogo', icon: PackageSearch, roles: ALL },
      { title: 'Líneas', href: '/lineas', icon: Layers, roles: ALL },
      { title: 'Acabados', href: '/acabados', icon: Palette, roles: ALL },
      // Los colores son una pestaña de `/catalogo` (D-273): el ítem abre esa pestaña.
      { title: 'Colores', href: '/catalogo?tab=colores', icon: Paintbrush, roles: ALL },
    ],
  },
  {
    label: 'Reportes',
    items: [
      {
        // RF-S4a/M2.
        title: 'Ventas y margen',
        href: '/reportes/ventas-margen',
        icon: TrendingUp,
        roles: [Role.ADMINISTRADOR],
      },
      {
        // RF-S4a/M1: llevan costos en cada fila y son solo del administrador.
        title: 'Inventario valorizado',
        href: '/reportes/inventario-valorizado',
        icon: Coins,
        roles: [Role.ADMINISTRADOR],
      },
      {
        // D-124: el corte mensual que la fecha de operación hace posible.
        title: 'Reporte mensual de bobinas',
        href: '/reportes/bobinas',
        icon: CalendarRange,
        roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
      },
    ],
  },
  {
    label: 'Administración',
    items: [
      { title: 'Usuarios', href: '/usuarios', icon: Users, roles: [Role.ADMINISTRADOR] },
      {
        // S10/M2: Márgenes y tipo de cambio comparten pantalla (pestañas en
        // configuracion/layout.tsx); el ítem apunta a la primera y sigue activo en la segunda.
        title: 'Márgenes y tipo de cambio',
        href: '/configuracion/margenes',
        activePrefix: ['/configuracion/margenes', '/configuracion/tipo-cambio'],
        icon: Percent,
        roles: [Role.ADMINISTRADOR],
      },
      {
        // D-218/RF-S2/M3: visor unificado de auditoría, admin-only (RF-95).
        title: 'Auditoría',
        href: '/auditoria',
        icon: ShieldCheck,
        roles: [Role.ADMINISTRADOR],
      },
      {
        // Lo que se configura del comercial —las reservas temporales (D-185)—: la tercera
        // pestaña de `/configuracion`.
        title: 'Configuración',
        href: '/configuracion/reservas',
        icon: Settings,
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
