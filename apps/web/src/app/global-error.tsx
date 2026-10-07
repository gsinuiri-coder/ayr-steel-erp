'use client';

import './globals.css';
import { ErrorScreen } from '@/components/error-screen';

/**
 * cc31: el último recurso, cuando falla el propio marco de la página. Reemplaza al `<html>`
 * entero, así que trae su hoja de estilos y fija la fuente del sistema.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="es">
      {/* Sin el layout no existe `--font-geist-sans`: se fija la fuente del sistema. */}
      <body className="antialiased" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
        <div className="flex min-h-svh">
          <ErrorScreen error={error} reset={reset} />
        </div>
      </body>
    </html>
  );
}
