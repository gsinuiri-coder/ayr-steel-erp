import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Skeleton } from '@/components/ui/skeleton';
import { KardexView } from './kardex-view';

export const metadata: Metadata = { title: 'Kardex' };

/** `useSearchParams` obliga a un límite de Suspense para que la página siga siendo estática. */
export default function KardexPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <KardexView />
    </Suspense>
  );
}
