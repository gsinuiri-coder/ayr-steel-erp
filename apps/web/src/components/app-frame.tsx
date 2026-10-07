'use client';

import { Suspense, useCallback, useState, type ReactNode } from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { Breadcrumb, CrumbProvider } from '@/components/breadcrumb';
import { DemoBadge } from '@/components/environment';
import { GoToContext, GoToDialog, useGoToShortcut } from '@/components/go-to-dialog';
import { PendingBell } from '@/components/pending-bell';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { useSession } from '@/lib/session';

/**
 * cc31: el marco de la app — menú lateral, barra superior y «Ir a».
 *
 * Con la contraseña temporal pendiente no hay marco: la pantalla de «Elige tu contraseña» ocupa
 * todo y no se ofrece navegar a ningún lado (el `SessionProvider` igual devuelve ahí).
 */
export function AppFrame({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const [goToOpen, setGoToOpen] = useState(false);
  const openGoTo = useCallback(() => {
    setGoToOpen(true);
  }, []);
  const toggleGoTo = useCallback(() => {
    setGoToOpen((open) => !open);
  }, []);
  // En el primer ingreso no hay marco: el atajo no hace nada (si no, el diálogo quedaba abierto
  // para cuando apareciera el marco).
  const noop = useCallback(() => undefined, []);
  useGoToShortcut(user.mustChangePassword ? noop : toggleGoTo);

  if (user.mustChangePassword) {
    return <>{children}</>;
  }

  return (
    <GoToContext.Provider value={openGoTo}>
      <CrumbProvider>
        <SidebarProvider>
          {/* `useSearchParams` del menú (ítem activo por `?tab=`) pide un límite de Suspense. */}
          <Suspense fallback={null}>
            <AppSidebar />
          </Suspense>
          <SidebarInset>
            {/*
              cc31: la barra lleva la ruta (grupo / lista / documento), que reemplaza al botón
              «Volver», la etiqueta de demo y la campana de pendientes. Sigue siendo una franja
              fina: el nombre del sistema ya está en la cabecera del menú (S11, B1).
            */}
            <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
              <SidebarTrigger className="-ml-1" aria-label="Mostrar u ocultar menú" />
              <Separator orientation="vertical" className="h-4" />
              {/* `useSearchParams` de la ruta pide un límite de Suspense. */}
              <Suspense fallback={null}>
                <Breadcrumb />
              </Suspense>
              <div className="ml-auto flex items-center gap-2">
                <DemoBadge />
                <PendingBell />
              </div>
            </header>
            {/*
              F8-S7/M4: un `<div>`, no un segundo `<main>`. `SidebarInset` ya es el `<main>` del
              panel (`sidebar.tsx`), así que esto anidaba dos landmarks `main`.
            */}
            <div className="flex flex-1 flex-col gap-3 p-4">{children}</div>
          </SidebarInset>
        </SidebarProvider>
        <GoToDialog open={goToOpen} onOpenChange={setGoToOpen} />
      </CrumbProvider>
    </GoToContext.Provider>
  );
}
