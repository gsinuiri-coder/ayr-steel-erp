import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Skeleton } from '@/components/ui/skeleton';
import { ProducirView } from './producir-view';

export const metadata: Metadata = { title: 'Producir un pedido' };

export default function ProducirPage() {
  // `useSearchParams` (para llegar acotado a un pedido desde `/pedidos/[id]`) obliga a un
  // límite de Suspense en el App Router; sin él el build falla al prerenderizar la ruta.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <ProducirView />
    </Suspense>
  );
}
