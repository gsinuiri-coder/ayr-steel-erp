import type { Metadata } from 'next';
import { TipoCambioView } from './tipo-cambio-view';

export const metadata: Metadata = { title: 'Tipo de cambio' };

export default function TipoCambioPage() {
  return <TipoCambioView />;
}
