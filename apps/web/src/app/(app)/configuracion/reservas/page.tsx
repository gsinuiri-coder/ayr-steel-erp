import type { Metadata } from 'next';
import { ReservasConfigView } from './reservas-config-view';

export const metadata: Metadata = { title: 'Reservas temporales' };

export default function ReservasConfigPage() {
  return <ReservasConfigView />;
}
