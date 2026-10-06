import { Suspense, type ReactNode } from 'react';
import { SessionProvider } from '@/lib/session';
import { AppSidebar } from '@/components/app-sidebar';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <SidebarProvider>
        {/* `useSearchParams` del menú (ítem activo por `?tab=`) pide un límite de Suspense. */}
        <Suspense fallback={null}>
          <AppSidebar />
        </Suspense>
        <SidebarInset>
          {/* Barra mínima: solo el interruptor del menú. El nombre del sistema ya está en
              la cabecera del menú lateral y repetirlo costaba una franja de 48 px en todas
              las pantallas (S11, B1). */}
          <header className="flex h-8 shrink-0 items-center gap-2 border-b px-3">
            <SidebarTrigger className="-ml-1" aria-label="Mostrar u ocultar menú" />
            <Separator orientation="vertical" className="h-4" />
          </header>
          {/*
            F8-S7/M4: un `<div>`, no un segundo `<main>`. `SidebarInset` ya es el `<main>` del
            panel (`sidebar.tsx`), así que esto anidaba dos landmarks `main` — inválido en HTML
            y ambiguo para un lector de pantalla, que espera uno solo por página. Se quita el
            de adentro y no el de afuera a propósito: los specs que usan `locator('main')` como
            alcance para excluir el menú siguen viendo lo mismo (lo único que se suma es la
            franja del interruptor, que no tiene texto).
          */}
          <div className="flex flex-1 flex-col gap-3 p-4">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </SessionProvider>
  );
}
