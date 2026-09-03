import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Skeleton } from '@/components/ui/skeleton';
import { PlantaView } from './planta-view';

export const metadata: Metadata = { title: 'Planta' };

export default function PlantaPage() {
  // `useSearchParams` (para abrir una OP concreta con `?op=`) obliga a un límite de
  // Suspense en el App Router; sin él el build falla al prerenderizar la ruta.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <PlantaView />
    </Suspense>
  );
}
