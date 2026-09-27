import type { Metadata } from 'next';
import { ImportarComprasView } from './importar-compras-view';

export const metadata: Metadata = { title: 'Importar compras' };

export default function ImportarComprasPage() {
  return <ImportarComprasView />;
}
