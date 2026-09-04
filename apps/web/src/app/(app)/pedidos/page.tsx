import type { Metadata } from 'next';
import { PedidosView } from './pedidos-view';

export const metadata: Metadata = { title: 'Pedidos' };

export default function PedidosPage() {
  return <PedidosView />;
}
