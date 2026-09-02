import type { Metadata } from 'next';
import { HomeGreeting } from './home-greeting';

export const metadata: Metadata = { title: 'Inicio' };

export default function HomePage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Inicio</h1>
      <HomeGreeting />
    </>
  );
}
