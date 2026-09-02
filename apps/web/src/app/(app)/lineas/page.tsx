import type { Metadata } from 'next';
import { LineasView } from './lineas-view';

export const metadata: Metadata = { title: 'Líneas de negocio' };

export default function LineasPage() {
  return <LineasView />;
}
