import type { Metadata } from 'next';
import { ProduccionView } from './produccion-view';

export const metadata: Metadata = { title: 'Órdenes de producción' };

export default function ProduccionPage() {
  return <ProduccionView />;
}
