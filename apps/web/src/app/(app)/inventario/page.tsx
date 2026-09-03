import type { Metadata } from 'next';
import { InventarioView } from './inventario-view';

export const metadata: Metadata = { title: 'Inventario' };

export default function InventarioPage() {
  return <InventarioView />;
}
