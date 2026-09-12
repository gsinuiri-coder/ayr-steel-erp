import type { Metadata } from 'next';
import { AgregarItemsView } from './agregar-items-view';

export const metadata: Metadata = { title: 'Agregar ítems al pedido' };

export default async function AgregarItemsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgregarItemsView id={id} />;
}
