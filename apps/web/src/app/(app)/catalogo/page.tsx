import type { Metadata } from 'next';
import { CatalogoView } from './catalogo-view';

export const metadata: Metadata = { title: 'Catálogo' };

export default function CatalogoPage() {
  return <CatalogoView />;
}
