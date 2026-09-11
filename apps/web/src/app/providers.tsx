'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>{children}</TooltipProvider>
      {/*
        Abajo a la derecha y no arriba: la barra de acciones de toda pantalla de detalle
        vive arriba a la derecha, y el toast la tapaba **y se comía el clic** —
        `document.elementFromPoint` sobre el centro de «Confirmar y reservar», «Anular» y
        «Duplicar» devolvía el toast—. Con dos toasts apilados (crear + emitir) la barra
        quedaba muerta varios segundos (S11, hallazgo T-02).
      */}
      <Toaster position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  );
}
