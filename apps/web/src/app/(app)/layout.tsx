import type { ReactNode } from 'react';
import { SessionProvider } from '@/lib/session';
import { AppFrame } from '@/components/app-frame';

/** El menú, la barra superior y «Ir a» viven en `AppFrame` (cc31). */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <AppFrame>{children}</AppFrame>
    </SessionProvider>
  );
}
