import type { Metadata } from 'next';
import { CompraDetalleView } from './compra-detalle-view';

export const metadata: Metadata = { title: 'Compra' };

export default async function CompraPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CompraDetalleView id={id} />;
}
