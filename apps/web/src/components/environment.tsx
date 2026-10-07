'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * cc31: si la app corre en el ambiente de demostración. Lo decide el servidor de Next con
 * `AYR_ENVIRONMENT` (lo pone `scripts/dev-demo.mjs`); el API no lo informa. En producción la
 * variable no existe y la etiqueta no aparece.
 */
const DemoContext = createContext(false);

export function EnvironmentProvider({
  isDemo,
  children,
}: {
  isDemo: boolean;
  children: ReactNode;
}) {
  return <DemoContext.Provider value={isDemo}>{children}</DemoContext.Provider>;
}

export function useIsDemo(): boolean {
  return useContext(DemoContext);
}

/** El aviso del ingreso en demo: nada de lo que se haga ahí llega a producción. */
export function DemoNotice() {
  if (!useIsDemo()) return null;
  return (
    <p role="note" className="rounded-lg bg-tone-warning px-3 py-2 text-tone-warning-foreground">
      Estás en la demo: nada de lo que hagas aquí llega a producción.
    </p>
  );
}

/** La etiqueta de la barra superior y del ingreso. */
export function DemoBadge({ label = 'Demo · datos de prueba' }: { label?: string }) {
  if (!useIsDemo()) return null;
  return (
    <span className="rounded-md bg-tone-warning px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-tone-warning-foreground">
      {label}
    </span>
  );
}
