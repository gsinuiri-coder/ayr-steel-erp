import type { Metadata } from 'next';
import { ProduccionView } from './produccion-view';

export const metadata: Metadata = { title: 'Producción' };

export default function ProduccionPage() {
  return <ProduccionView />;
}
