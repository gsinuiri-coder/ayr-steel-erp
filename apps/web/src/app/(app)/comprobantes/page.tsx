import type { Metadata } from 'next';
import { ComprobantesView } from './comprobantes-view';

export const metadata: Metadata = { title: 'Comprobantes' };

export default function ComprobantesPage() {
  return <ComprobantesView />;
}
