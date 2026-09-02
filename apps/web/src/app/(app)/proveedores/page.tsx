import type { Metadata } from 'next';
import { ProveedoresView } from './proveedores-view';

export const metadata: Metadata = { title: 'Proveedores' };

export default function ProveedoresPage() {
  return <ProveedoresView />;
}
