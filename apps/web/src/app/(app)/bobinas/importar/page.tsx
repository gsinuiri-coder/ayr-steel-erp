import type { Metadata } from 'next';
import { ImportarBobinasView } from './importar-view';

export const metadata: Metadata = { title: 'Importar bobinas' };

export default function ImportarBobinasPage() {
  return <ImportarBobinasView />;
}
