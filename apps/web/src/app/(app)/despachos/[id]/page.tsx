import type { Metadata } from 'next';
import { DespachoDetalleView } from './despacho-detalle-view';

export const metadata: Metadata = { title: 'Despacho' };

export default async function DespachoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DespachoDetalleView id={id} />;
}
