import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Skeleton } from '@/components/ui/skeleton';
import { TandaView } from './tanda-view';

export const metadata: Metadata = { title: 'Reportar producción en tanda' };

export default function TandaPage() {
  // `useSearchParams` (para llegar filtrado por pedido desde `/pedidos/[id]`) obliga a un
  // límite de Suspense en el App Router; sin él el build falla al prerenderizar la ruta.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <TandaView />
    </Suspense>
  );
}
