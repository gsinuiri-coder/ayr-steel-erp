'use client';

import Link from 'next/link';
import { ChevronsUpDown, KeyRound, LogOut } from 'lucide-react';
import { ROLE_LABELS } from '@ayr/shared';
import { useSession } from '@/lib/session';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenuButton } from '@/components/ui/sidebar';

/** Las iniciales del nombre: «Giancarlo Sinuiri» → «GS». */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

/**
 * cc31: el menú de usuario al pie del menú lateral. Además de cerrar sesión lleva a «Cambiar
 * contraseña», que antes no se alcanzaba desde ningún lugar de la app.
 */
export function UserMenu() {
  const { user, logout, isLoggingOut } = useSession();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          className="data-[state=open]:bg-sidebar-accent"
          aria-label={`Menú de ${user.name}`}
          tooltip={user.name}
        >
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-xs font-semibold"
          >
            {initials(user.name)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
            <span className="truncate text-sm font-medium" title={user.email}>
              {user.name}
            </span>
            <span className="truncate text-xs text-muted-foreground">{ROLE_LABELS[user.role]}</span>
          </span>
          <ChevronsUpDown className="ml-auto size-3.5 text-muted-foreground" aria-hidden />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/cambiar-contrasena">
            <KeyRound />
            Cambiar contraseña
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={isLoggingOut}
          onSelect={() => {
            logout();
          }}
        >
          <LogOut />
          Cerrar sesión
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
