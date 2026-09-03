import type { Metadata } from 'next';
import { FlejesView } from './flejes-view';

export const metadata: Metadata = { title: 'Flejes' };

export default function FlejesPage() {
  return <FlejesView />;
}
