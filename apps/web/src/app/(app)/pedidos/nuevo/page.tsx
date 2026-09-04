import type { Metadata } from 'next';
import { SalesDocumentForm } from '@/components/sales/sales-document-form';

export const metadata: Metadata = { title: 'Nuevo pedido' };

export default function NuevoPedidoPage() {
  return <SalesDocumentForm mode="order" />;
}
