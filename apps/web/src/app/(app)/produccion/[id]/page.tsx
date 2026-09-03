import type { Metadata } from 'next';
import { ProduccionDetalleView } from './produccion-detalle-view';

export const metadata: Metadata = { title: 'Orden de producción' };

export default async function ProduccionDetallePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProduccionDetalleView id={id} />;
}
