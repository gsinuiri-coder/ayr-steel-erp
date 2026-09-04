import type { Metadata } from 'next';
import { SalesDocumentForm } from '@/components/sales/sales-document-form';

export const metadata: Metadata = { title: 'Nueva cotización' };

export default function NuevaCotizacionPage() {
  return <SalesDocumentForm mode="quotation" />;
}
