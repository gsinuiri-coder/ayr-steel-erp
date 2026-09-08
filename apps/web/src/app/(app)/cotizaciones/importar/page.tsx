import type { Metadata } from 'next';
import { ImportarCotizacionesView } from './importar-view';

export const metadata: Metadata = { title: 'Importar cotizaciones' };

export default function ImportarCotizacionesPage() {
  return <ImportarCotizacionesView />;
}
