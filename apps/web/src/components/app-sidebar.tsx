'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { ROLE_LABELS } from '@ayr/shared';
import { navForRole } from '@/lib/nav';
import { useSession } from '@/lib/session';
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
} from '@/components/ui/sidebar';

/** Menú lateral filtrado por rol (§3.4). */
export function AppSidebar() {
  const pathname = usePathname();
  const { user, logout, isLoggingOut } = useSession();
  const groups = navForRole(user.role);

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
        {groups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
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
                        isActive={
                          item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
                        }
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
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="border-t p-3">
        <div className="min-w-0 group-data-[collapsible=icon]:hidden">
          <p className="truncate text-sm font-medium">{user.name}</p>
          <p className="truncate text-xs text-muted-foreground" title={user.email}>
            {user.email}
          </p>
          <p className="text-xs text-muted-foreground">{ROLE_LABELS[user.role]}</p>
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
