'use client';

import { useState, type ReactNode } from 'react';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectionBanner, useOnline } from '@/components/connection-banner';
import { EnvironmentProvider } from '@/components/environment';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { LIVE_PENDING_QUERY_KEYS } from '@/lib/pending';

export function Providers({ children, isDemo }: { children: ReactNode; isDemo: boolean }) {
  const [client] = useState(() => {
    // Varias operaciones seguidas (una ráfaga de ediciones en línea) refrescan la campana una
    // sola vez: el límite de peticiones del API es compartido por toda la oficina.
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshPending = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        for (const queryKey of LIVE_PENDING_QUERY_KEYS) {
          // Si ya hay una petición en curso de esa consulta, se reutiliza.
          void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
        }
      }, 1_500);
    };
    const queryClient: QueryClient = new QueryClient({
      defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
      // cc32: la campana se pone al día con cada operación que termina bien (despachar,
      // emitir, anular…) en vez de esperar al minuto. Solo vuelve a pedir las consultas que
      // están en pantalla.
      mutationCache: new MutationCache({
        onSuccess: (_data, _variables, _context, mutation) => {
          // Cerrar sesión no mueve pendientes: refrescar ahí solo daría 401.
          if (mutation.meta?.skipPendingRefresh === true) return;
          refreshPending();
        },
      }),
    });
    return queryClient;
  });
  const online = useOnline();
  return (
    <QueryClientProvider client={client}>
      <EnvironmentProvider isDemo={isDemo}>
        <TooltipProvider>{children}</TooltipProvider>
      </EnvironmentProvider>
      {/*
        Abajo a la derecha y no arriba: la barra de acciones de toda pantalla de detalle
        vive arriba a la derecha, y el toast la tapaba **y se comía el clic** —
        `document.elementFromPoint` sobre el centro de «Confirmar y reservar», «Anular» y
        «Duplicar» devolvía el toast—. Con dos toasts apilados (crear + emitir) la barra
        quedaba muerta varios segundos (S11, hallazgo T-02).
      */}
      {/*
        cc31: el error y la advertencia se quedan hasta cerrarlos, así que no pueden tapar la
        barra fija de los formularios (su «Guardar» vive en esta misma esquina): los mensajes
        flotan por encima de ella, y más arriba aún con la franja «Sin conexión».
      */}
      <Toaster
        position="bottom-right"
        richColors
        closeButton
        offset={{ bottom: online ? 72 : 112, right: 24 }}
      />
      <ConnectionBanner />
    </QueryClientProvider>
  );
}
