'use client';

import { useSyncExternalStore } from 'react';
import { WifiOffIcon } from 'lucide-react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** `true` mientras el navegador tenga red. En el servidor se asume que sí. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

/**
 * cc31: franja fija abajo mientras el navegador no tenga red. Sin ella, cada botón fallaba por
 * su cuenta con un error distinto y nadie sabía que el problema era la conexión.
 */
export function ConnectionBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center gap-2 bg-foreground px-4 py-2 text-sm text-background"
    >
      <WifiOffIcon className="size-4" aria-hidden />
      <span className="font-semibold">Sin conexión</span>
      <span className="opacity-90">Vuelve a intentar cuando regrese la red.</span>
    </div>
  );
}
