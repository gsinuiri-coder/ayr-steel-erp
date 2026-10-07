'use client';

import './globals.css';
import { ErrorScreen } from '@/components/error-screen';

/**
 * cc31: el último recurso, cuando falla el propio marco de la página. Reemplaza al `<html>`
 * entero, así que trae su hoja de estilos; la fuente cae a la del sistema.
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
      <body className="antialiased">
        <div className="flex min-h-svh">
          <ErrorScreen error={error} reset={reset} />
        </div>
      </body>
    </html>
  );
}
