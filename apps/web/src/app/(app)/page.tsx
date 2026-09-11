import type { Metadata } from 'next';
import { HomeGreeting } from './home-greeting';

export const metadata: Metadata = { title: 'Panel' };

export default function HomePage() {
  return (
    <>
      <h1 className="text-lg font-semibold">Panel</h1>
      <HomeGreeting />
    </>
  );
}
