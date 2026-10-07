'use client';

import { ErrorScreen } from '@/components/error-screen';

/** cc31: una pantalla de la app que falla; el menú y la barra siguen en su lugar. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorScreen error={error} reset={reset} />;
}
