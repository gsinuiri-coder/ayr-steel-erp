'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { businessToday } from '@ayr/shared';
import { NAV, navForRole, type NavItem } from '@/lib/nav';
import { expiringQuotationDates } from '@/lib/pending';
import { useSession } from '@/lib/session';
import { useOpenGoTo } from '@/components/go-to-dialog';
import { BrandMark } from '@/components/brand-mark';
import { usePendingSources } from '@/components/pending-bell';
import { UserMenu } from '@/components/user-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';

/** `?a=b&c=d` de un `href` como pares, para comparar con la query de la pantalla. */
function queryOf(href: string): [string, string][] {
  return [...new URLSearchParams(href.split('?')[1] ?? '').entries()];
}

/**
 * ¿La ruta actual pertenece a este ítem del menú? (la misma regla que marca el ítem activo).
 *
 * D-326: dos ítems pueden apuntar a la misma ruta con y sin query (`/catalogo` y
 * `/catalogo?tab=colores`). El que lleva query solo está activo si la pantalla tiene esa query, y el
 * que no la lleva deja de estarlo cuando un hermano con query sí lo está: sin esto los dos se
 * marcaban a la vez.
 */
function isItemActive(item: NavItem, pathname: string, search: URLSearchParams): boolean {
  if (item.href === '/') return pathname === '/';
  // `href` puede llevar query: para el prefijo de ruta cuenta solo el path.
  const prefixes = item.activePrefix ?? item.href.split('?')[0] ?? item.href;
  const onPath = (Array.isArray(prefixes) ? prefixes : [prefixes]).some((prefix) =>
    pathname.startsWith(prefix as string),
  );
  if (!onPath) return false;
  const own = queryOf(item.href);
  if (own.length > 0) return own.every(([key, value]) => search.get(key) === value);
  // Sin query propia: no está activo si un hermano de la misma ruta con query sí lo está.
  const path = item.href.split('?')[0];
  return !NAV.flatMap((g) => g.items).some(
    (other) =>
      other !== item &&
      other.href.split('?')[0] === path &&
      queryOf(other.href).length > 0 &&
      queryOf(other.href).every(([key, value]) => search.get(key) === value),
  );
}

/**
 * Menú lateral filtrado por rol (§3.4).
 *
 * D-292: **acordeón** — un solo grupo abierto a la vez. Al navegar se abre el grupo del ítem
 * activo (y cierra el anterior); pulsar la cabecera de otro grupo lo abre y cierra el que
 * estaba abierto; pulsar la del grupo abierto lo cierra. `Panel`, que no tiene grupo, queda
 * siempre a la vista. Con el menú colapsado a íconos no hay cabeceras y todos los ítems se
 * ven: un ícono escondido detrás de un grupo cerrado no se puede alcanzar.
 */
export function AppSidebar() {
  const pathname = usePathname();
  const search = useSearchParams();
  const { state: sidebarState } = useSidebar();
  const iconOnly = sidebarState === 'collapsed';
  const { user } = useSession();
  const groups = navForRole(user.role);
  const activeGroupLabel =
    groups.find((g) => g.label && g.items.some((i) => !i.soon && isItemActive(i, pathname, search)))
      ?.label ?? null;
  const [openGroup, setOpenGroup] = useState<string | null>(activeGroupLabel);
  // Navegar (incluido el «atrás» del navegador) abre el grupo de la pantalla en la que se cae.
  useEffect(() => {
    if (activeGroupLabel !== null) setOpenGroup(activeGroupLabel);
  }, [activeGroupLabel]);
  // cc31: los contadores del menú salen de las mismas consultas que la campana, y solo donde el
  // API ya entrega la cifra. RF-38: la cola de producción, para quien ve `/planta`.
  const pending = usePendingSources();
  const openGoTo = useOpenGoTo();
  const counters: Record<string, { count: number; title: (n: string) => string }> = {
    '/cotizaciones': {
      count: expiringQuotationDates(pending.emittedQuotations ?? [], businessToday()).length,
      title: (n) => `${n} cotizaciones por vencer esta semana`,
    },
    '/reservas-temporales': {
      count: pending.temporaryReservations?.length ?? 0,
      title: (n) => `${n} reservas temporales vigentes`,
    },
    '/despachos': {
      count: pending.readyOrders ?? 0,
      title: (n) => `${n} pedidos listos para despachar`,
    },
    '/planta': {
      count: pending.productionQueue ?? 0,
      title: (n) => `${n} órdenes esperando producción`,
    },
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-2 px-3 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <BrandMark />
          <span className="truncate group-data-[collapsible=icon]:hidden">Steel ERP</span>
        </Link>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              variant="outline"
              tooltip="Ir a… (Ctrl K)"
              className="text-muted-foreground"
              onClick={openGoTo}
            >
              <Search />
              <span>Ir a…</span>
              <kbd className="ml-auto rounded border px-1 text-xs group-data-[collapsible=icon]:hidden">
                Ctrl K
              </kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {groups.map((group) => {
          const collapsible = Boolean(group.label);
          const isOpen = !collapsible || iconOnly || openGroup === group.label;
          return (
            <SidebarGroup key={group.label || 'sin-grupo'}>
              {collapsible && (
                <SidebarGroupLabel asChild>
                  <button
                    type="button"
                    data-state={isOpen ? 'open' : 'closed'}
                    aria-expanded={isOpen}
                    aria-controls={`nav-group-${group.label}`}
                    tabIndex={iconOnly ? -1 : 0}
                    className="w-full cursor-pointer justify-between hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    onClick={() => {
                      setOpenGroup((current) => (current === group.label ? null : group.label));
                    }}
                  >
                    <span>{group.label}</span>
                    <ChevronRight
                      aria-hidden
                      className="transition-transform group-data-[collapsible=icon]:hidden data-[state=open]:rotate-90"
                      data-state={isOpen ? 'open' : 'closed'}
                    />
                  </button>
                </SidebarGroupLabel>
              )}
              <SidebarGroupContent id={`nav-group-${group.label}`} hidden={!isOpen}>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      {item.soon ? (
                        <SidebarMenuButton
                          disabled
                          aria-disabled
                          tooltip={`${item.title} (próximamente)`}
                          className="opacity-60"
                        >
                          <item.icon />
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                      ) : (
                        <SidebarMenuButton
                          asChild
                          isActive={isItemActive(item, pathname, search)}
                          tooltip={item.title}
                        >
                          <Link href={item.href}>
                            <item.icon />
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
                      )}
                      {item.soon && (
                        <SidebarMenuBadge className="group-data-[collapsible=icon]:hidden">
                          Pronto
                        </SidebarMenuBadge>
                      )}
                      {(counters[item.href]?.count ?? 0) > 0 && (
                        <SidebarMenuBadge
                          className="group-data-[collapsible=icon]:hidden"
                          title={counters[item.href]?.title(String(counters[item.href]?.count))}
                        >
                          {counters[item.href]?.count}
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      {/* cc31: el pie es el menú de usuario (cambiar contraseña y cerrar sesión), en una sola
          fila: el menú ya casi no entra a 768 px de alto (S11/B2). */}
      <SidebarFooter className="border-t p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <UserMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
