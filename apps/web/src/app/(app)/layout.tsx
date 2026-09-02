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
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" aria-label="Mostrar u ocultar menú" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <span className="text-sm text-muted-foreground">AYR Steel ERP</span>
          </header>
          <main className="flex flex-1 flex-col gap-6 p-6">{children}</main>
        </SidebarInset>
      </SidebarProvider>
    </SessionProvider>
  );
}
