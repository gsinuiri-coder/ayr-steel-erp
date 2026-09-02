'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { AuthUser } from '@ayr/shared';
import { api, ApiError } from './api';

interface SessionContextValue {
  user: AuthUser;
  logout: () => void;
  isLoggingOut: boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export const ME_QUERY_KEY = ['auth', 'me'] as const;

export function fetchMe(): Promise<AuthUser> {
  return api<{ user: AuthUser }>('/auth/me').then((r) => r.user);
}

/**
 * Carga el usuario actual; si el API rechaza la sesión (revocada, expirada,
 * usuario desactivado) redirige a /login. Fuerza /cambiar-contrasena si aplica.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const me = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const logout = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST', noRefresh: true }),
    // Recarga completa: limpia todo estado en memoria y evita que el refetch de /auth/me redirija con ?next.
    onSettled: () => {
      window.location.assign('/login');
    },
  });

  const unauthorized = me.isError && me.error instanceof ApiError && me.error.status === 401;
  const mustChange = me.data?.mustChangePassword === true && pathname !== '/cambiar-contrasena';

  useEffect(() => {
    if (unauthorized) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else if (mustChange) router.replace('/cambiar-contrasena');
  }, [unauthorized, mustChange, pathname, router]);

  if (me.isPending || unauthorized || mustChange) {
    return (
      <div
        className="flex min-h-svh items-center justify-center text-muted-foreground"
        role="status"
      >
        Cargando sesión…
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-2" role="alert">
        <p>No se pudo cargar la sesión.</p>
        <button className="underline" onClick={() => void me.refetch()}>
          Reintentar
        </button>
      </div>
    );
  }

  return (
    <SessionContext.Provider
      value={{
        user: me.data,
        logout: () => {
          logout.mutate();
        },
        isLoggingOut: logout.isPending,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession debe usarse dentro de <SessionProvider>');
  return ctx;
}
