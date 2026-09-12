import type { Metadata } from 'next';
import { ReservasTemporalesView } from './reservas-temporales-view';

export const metadata: Metadata = { title: 'Reservas temporales' };

export default function ReservasTemporalesPage() {
  return <ReservasTemporalesView />;
}
