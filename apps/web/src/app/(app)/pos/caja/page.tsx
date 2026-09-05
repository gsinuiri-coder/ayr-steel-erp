import type { Metadata } from 'next';
import { CajaView } from './caja-view';

export const metadata: Metadata = { title: 'Caja' };

export default function CajaPage() {
  return <CajaView />;
}
