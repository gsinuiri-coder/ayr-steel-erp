import type { Metadata } from 'next';
import { ImportarPreciosView } from './importar-precios-view';

export const metadata: Metadata = { title: 'Cargar precios de lista' };

export default function ImportarPreciosPage() {
  return <ImportarPreciosView />;
}
