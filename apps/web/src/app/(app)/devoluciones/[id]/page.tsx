import type { Metadata } from 'next';
import { DevolucionDetalleView } from './devolucion-detalle-view';

export const metadata: Metadata = { title: 'Devolución' };

export default async function DevolucionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DevolucionDetalleView id={id} />;
}
