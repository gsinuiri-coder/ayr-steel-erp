import type { ReactNode } from 'react';
import { SessionProvider } from '@/lib/session';
import { AppSidebar } from '@/components/app-sidebar';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          {/* Barra mínima: solo el interruptor del menú. El nombre del sistema ya está en
              la cabecera del menú lateral y repetirlo costaba una franja de 48 px en todas
              las pantallas (S11, B1). */}
          <header className="flex h-8 shrink-0 items-center gap-2 border-b px-3">
            <SidebarTrigger className="-ml-1" aria-label="Mostrar u ocultar menú" />
            <Separator orientation="vertical" className="h-4" />
          </header>
          <main className="flex flex-1 flex-col gap-3 p-4">{children}</main>
        </SidebarInset>
      </SidebarProvider>
    </SessionProvider>
  );
}
