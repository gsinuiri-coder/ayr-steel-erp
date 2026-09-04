import type { Metadata } from 'next';
import { CotizacionDetalleView } from './cotizacion-detalle-view';

export const metadata: Metadata = { title: 'Cotización' };

export default async function CotizacionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CotizacionDetalleView id={id} />;
}
