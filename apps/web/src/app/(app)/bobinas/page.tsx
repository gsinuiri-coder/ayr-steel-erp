import type { Metadata } from 'next';
import { BobinasView } from './bobinas-view';

export const metadata: Metadata = { title: 'Bobinas' };

export default function BobinasPage() {
  return <BobinasView />;
}
