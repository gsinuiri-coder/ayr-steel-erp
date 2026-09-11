import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Providers } from './providers';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: { default: 'AYR Steel ERP', template: '%s · AYR Steel ERP' },
  description: 'Gestión de bobinas, producción y ventas de AYR Steel',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // Las variables de next/font van en <html>, no en <body>: `globals.css` aplica
    // `font-sans` sobre <html> y ahí `--font-geist-sans` no existía, así que
    // `font-family: var(--font-sans)` quedaba inválida y toda la app caía a la fuente
    // serif por defecto del navegador (S11, hallazgo T-01).
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
