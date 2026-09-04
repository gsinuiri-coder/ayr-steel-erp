import type { Metadata } from 'next';
import { PedidoDetalleView } from './pedido-detalle-view';

export const metadata: Metadata = { title: 'Pedido' };

export default async function PedidoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PedidoDetalleView id={id} />;
}
