'use client';

import { useQuery } from '@tanstack/react-query';
import type { QuotationDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { SalesDocumentForm } from '@/components/sales/sales-document-form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';

/** D-184: editar una cotización no confirmada con el mismo formulario del alta. */
export function EditarCotizacionView({ id }: { id: string }) {
  const quotation = useQuery({
    queryKey: ['quotation', id],
    queryFn: () => api<QuotationDto>(`/sales/quotations/${id}`),
  });

  if (quotation.isPending) return <Skeleton className="h-64 w-full" />;
  if (quotation.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>No se pudo cargar la cotización.</AlertDescription>
      </Alert>
    );
  }
  const q = quotation.data;
  if (q.status === 'CONFIRMED' || q.status === 'CANCELLED') {
    return (
      <Alert>
        <AlertDescription>
          {q.code} está {q.status === 'CONFIRMED' ? 'confirmada' : 'anulada'} y ya no se edita.
        </AlertDescription>
      </Alert>
    );
  }
  return <SalesDocumentForm key={q.id} mode="quotation" initial={q} />;
}
