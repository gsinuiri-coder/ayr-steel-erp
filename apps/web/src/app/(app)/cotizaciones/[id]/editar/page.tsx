import type { Metadata } from 'next';
import { EditarCotizacionView } from './editar-cotizacion-view';

export const metadata: Metadata = { title: 'Editar cotización' };

export default async function EditarCotizacionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EditarCotizacionView id={id} />;
}
