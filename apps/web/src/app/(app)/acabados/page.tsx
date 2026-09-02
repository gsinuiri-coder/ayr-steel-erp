import type { Metadata } from 'next';
import { AcabadosView } from './acabados-view';

export const metadata: Metadata = { title: 'Acabados' };

export default function AcabadosPage() {
  return <AcabadosView />;
}
