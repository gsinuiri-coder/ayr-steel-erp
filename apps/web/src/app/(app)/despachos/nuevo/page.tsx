import type { Metadata } from 'next';
import { NuevoDespachoView } from './nuevo-despacho-view';

export const metadata: Metadata = { title: 'Nuevo despacho' };

export default function NuevoDespachoPage() {
  return <NuevoDespachoView />;
}
