'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ChevronRight, LogOut } from 'lucide-react';
import { ROLE_LABELS, Role } from '@ayr/shared';
import { navForRole, type NavItem } from '@/lib/nav';
import { useSession } from '@/lib/session';
import { useProductionQueue } from '@/components/production-queue';
import { Button } from '@/components/ui/button';
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

/** ¿La ruta actual pertenece a este ítem del menú? (la misma regla que marca el ítem activo). */
function isItemActive(item: NavItem, pathname: string): boolean {
  if (item.href === '/') return pathname === '/';
  // `href` puede llevar query (`/catalogo?tab=colores`): para marcar el ítem activo cuenta el path.
  const prefixes = item.activePrefix ?? item.href.split('?')[0] ?? item.href;
  return (Array.isArray(prefixes) ? prefixes : [prefixes]).some((prefix) =>
    pathname.startsWith(prefix as string),
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
  const { state: sidebarState } = useSidebar();
  const iconOnly = sidebarState === 'collapsed';
  const { user, logout, isLoggingOut } = useSession();
  const groups = navForRole(user.role);
  const activeGroupLabel =
    groups.find((g) => g.label && g.items.some((i) => !i.soon && isItemActive(i, pathname)))
      ?.label ?? null;
  const [openGroup, setOpenGroup] = useState<string | null>(activeGroupLabel);
  // Navegar (incluido el «atrás» del navegador) abre el grupo de la pantalla en la que se cae.
  useEffect(() => {
    if (activeGroupLabel !== null) setOpenGroup(activeGroupLabel);
  }, [activeGroupLabel]);
  // RF-38: cuántos pedidos esperan producción. Solo para quien ve `/planta` en el menú.
  const seesPlanta = ([Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA] as Role[]).includes(user.role);
  const queue = useProductionQueue({ enabled: seesPlanta });
  const queueCount = queue.data?.length ?? 0;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            AYR
          </span>
          <span className="truncate group-data-[collapsible=icon]:hidden">Steel ERP</span>
        </Link>
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
                          isActive={isItemActive(item, pathname)}
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
                      {item.href === '/planta' && queueCount > 0 && (
                        <SidebarMenuBadge
                          className="group-data-[collapsible=icon]:hidden"
                          title={`${String(queueCount)} órdenes esperando producción`}
                        >
                          {queueCount}
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
      {/* S11/B2: el pie ocupaba 113 px de un menú que ya no entra a 768 px de alto. El correo
          pasa al `title` —se usa para identificarse, no se lee— y el rol acompaña al nombre
          en la misma línea. */}
      <SidebarFooter className="border-t p-2">
        <div className="min-w-0 group-data-[collapsible=icon]:hidden">
          <p className="truncate text-xs font-medium" title={user.email}>
            {user.name}{' '}
            <span className="font-normal text-muted-foreground">{ROLE_LABELS[user.role]}</span>
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start group-data-[collapsible=icon]:justify-center"
          onClick={logout}
          disabled={isLoggingOut}
        >
          <LogOut />
          <span className="group-data-[collapsible=icon]:hidden">Cerrar sesión</span>
        </Button>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
