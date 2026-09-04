import type { Metadata } from 'next';
import { CobranzasView } from './cobranzas-view';

export const metadata: Metadata = { title: 'Cobranzas' };

export default function CobranzasPage() {
  return <CobranzasView />;
}
