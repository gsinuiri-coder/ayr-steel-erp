import type { Metadata } from 'next';
import { PosView } from './pos-view';

export const metadata: Metadata = { title: 'Mostrador' };

export default function PosPage() {
  return <PosView />;
}
