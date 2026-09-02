import type { Metadata } from 'next';
import { NuevaXmlView } from './nueva-xml-view';

export const metadata: Metadata = { title: 'Bobinas desde XML' };

export default function NuevaXmlPage() {
  return <NuevaXmlView />;
}
