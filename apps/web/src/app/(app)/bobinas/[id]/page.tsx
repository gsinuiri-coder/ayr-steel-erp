import type { Metadata } from 'next';
import { BobinaDetalleView } from './bobina-detalle-view';

export const metadata: Metadata = { title: 'Bobina' };

export default async function BobinaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BobinaDetalleView id={id} />;
}
