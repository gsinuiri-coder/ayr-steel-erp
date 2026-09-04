import type { Metadata } from 'next';
import { ComprobanteDetalleView } from './comprobante-detalle-view';

export const metadata: Metadata = { title: 'Comprobante' };

export default async function ComprobantePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ComprobanteDetalleView id={id} />;
}
