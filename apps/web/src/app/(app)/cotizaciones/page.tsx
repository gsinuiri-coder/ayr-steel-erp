import type { Metadata } from 'next';
import { CotizacionesView } from './cotizaciones-view';

export const metadata: Metadata = { title: 'Cotizaciones' };

export default function CotizacionesPage() {
  return <CotizacionesView />;
}
