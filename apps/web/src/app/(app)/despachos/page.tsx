import type { Metadata } from 'next';
import { DespachosView } from './despachos-view';

export const metadata: Metadata = { title: 'Despachos' };

export default function DespachosPage() {
  return <DespachosView />;
}
