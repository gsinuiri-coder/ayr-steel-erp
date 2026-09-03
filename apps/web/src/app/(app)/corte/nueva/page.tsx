import type { Metadata } from 'next';
import { NuevaOrdenCorteView } from './nueva-orden-view';

export const metadata: Metadata = { title: 'Enviar a corte' };

export default function NuevaOrdenCortePage() {
  return <NuevaOrdenCorteView />;
}
