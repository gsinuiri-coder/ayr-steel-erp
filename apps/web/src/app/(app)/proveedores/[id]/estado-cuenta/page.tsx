import type { Metadata } from 'next';
import { EstadoCuentaView } from './estado-cuenta-view';

export const metadata: Metadata = { title: 'Estado de cuenta' };

export default async function EstadoCuentaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EstadoCuentaView supplierId={id} />;
}
