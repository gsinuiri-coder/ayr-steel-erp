import type { Metadata } from 'next';
import { NuevoComprobanteView } from './nuevo-comprobante-view';

export const metadata: Metadata = { title: 'Nuevo comprobante' };

export default function NuevoComprobantePage() {
  return <NuevoComprobanteView />;
}
