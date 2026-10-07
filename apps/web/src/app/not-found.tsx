import Link from 'next/link';
import { ScreenMessage } from '@/components/error-screen';
import { Button } from '@/components/ui/button';

export const metadata = { title: 'Página no encontrada' };

/** cc31: una dirección que no existe (antes, «404 This page could not be found»). */
export default function NotFound() {
  return (
    <div className="flex min-h-svh">
      <ScreenMessage
        title="No encontramos esa página"
        actions={
          <Button size="sm" asChild>
            <Link href="/">Ir al Panel</Link>
          </Button>
        }
      >
        <p className="max-w-sm text-muted-foreground">
          Puede que el enlace esté mal escrito o que el documento se haya anulado.
        </p>
      </ScreenMessage>
    </div>
  );
}
