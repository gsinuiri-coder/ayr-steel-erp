import type { Metadata } from 'next';
import { MargenesView } from './margenes-view';

export const metadata: Metadata = { title: 'Márgenes' };

export default function MargenesPage() {
  return <MargenesView />;
}
