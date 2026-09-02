import { Suspense } from 'react';
import type { Metadata } from 'next';
import { NuevaCompraView } from './nueva-compra-view';

export const metadata: Metadata = { title: 'Nueva compra' };

export default function NuevaCompraPage() {
  // `useSearchParams` (el `?tipo=`) obliga a un límite de Suspense en el App Router.
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Cargando…</p>}>
      <NuevaCompraView />
    </Suspense>
  );
}
