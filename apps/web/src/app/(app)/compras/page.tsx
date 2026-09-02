import type { Metadata } from 'next';
import { ComprasView } from './compras-view';

export const metadata: Metadata = { title: 'Compras' };

export default function ComprasPage() {
  return <ComprasView />;
}
