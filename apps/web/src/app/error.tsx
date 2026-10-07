'use client';

import { ErrorScreen } from '@/components/error-screen';

/** cc31: una pantalla que falla fuera del marco de la app (por ejemplo, el ingreso). */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-svh">
      <ErrorScreen error={error} reset={reset} />
    </div>
  );
}
