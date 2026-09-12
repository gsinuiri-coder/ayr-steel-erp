'use client';

import { useQuery } from '@tanstack/react-query';
import type { SalesOrderDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { SalesDocumentForm } from '@/components/sales/sales-document-form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * D-187: agregar ítems a un pedido confirmado con el mismo formulario de líneas de la
 * cotización —misma validación, mismo panel de stock, mismo piso de precio—. Cada ítem
 * reserva al guardar y, si se fabrica, nace con su orden de producción.
 */
export function AgregarItemsView({ id }: { id: string }) {
  const order = useQuery({
    queryKey: ['sales-order', id],
    queryFn: () => api<SalesOrderDto>(`/sales/orders/${id}`),
  });

  if (order.isPending) return <Skeleton className="h-64 w-full" />;
  if (order.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>No se pudo cargar el pedido.</AlertDescription>
      </Alert>
    );
  }
  const o = order.data;
  if (!o.isEditable) {
    return (
      <Alert>
        <AlertDescription>
          {o.code} {o.status === 'CANCELLED' ? 'está anulado' : 'ya tiene comprobante'}: no se le
          agregan ítems.
        </AlertDescription>
      </Alert>
    );
  }
  return <SalesDocumentForm key={o.id} mode="order" addTo={o} />;
}
