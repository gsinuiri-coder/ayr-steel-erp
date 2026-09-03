import type { Metadata } from 'next';
import { CorteView } from './corte-view';

export const metadata: Metadata = { title: 'Corte tercerizado' };

export default function CortePage() {
  return <CorteView />;
}
