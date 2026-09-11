'use client';

import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const TABS = [
  { value: 'margenes', label: 'Márgenes' },
  { value: 'tipo-cambio', label: 'Tipo de cambio' },
] as const;

/**
 * S10/M2: Márgenes y tipo de cambio comparten una sola entrada del menú lateral
 * (Administración). Las dos siguen siendo rutas propias —`/configuracion/margenes`,
 * `/configuracion/tipo-cambio`— sin cambiar: esto es solo cómo se navega entre ellas,
 * no dónde viven.
 */
export default function ConfiguracionLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // El primero es el fallback: no hay `page.tsx` en `/configuracion` a secas, pero si
  // alguna vez algo enlaza ahí directo, mejor una pestaña marcada que ninguna.
  const active =
    TABS.find((t) => pathname.startsWith(`/configuracion/${t.value}`))?.value ?? TABS[0].value;

  return (
    <div className="space-y-4">
      <Tabs
        value={active}
        onValueChange={(v) => {
          router.push(`/configuracion/${v}`);
        }}
      >
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {children}
    </div>
  );
}
