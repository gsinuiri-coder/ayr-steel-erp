import type { Metadata } from 'next';
import { CorteDetalleView } from './corte-detalle-view';

export const metadata: Metadata = { title: 'Orden de corte' };

export default async function CorteDetallePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CorteDetalleView id={id} />;
}
