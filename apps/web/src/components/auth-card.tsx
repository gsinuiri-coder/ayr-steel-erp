import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { DemoBadge } from '@/components/environment';

/**
 * cc31: la tarjeta centrada del ingreso y del primer ingreso, con el sello AYR. Ocupa toda la
 * pantalla: aquí no hay menú.
 */
export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <div className="grid w-full max-w-sm gap-5 rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <BrandMark />
          <span className="font-semibold">AYR Steel ERP</span>
          <span className="ml-auto">
            <DemoBadge label="Demo" />
          </span>
        </div>
        <div className="grid gap-1">
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="text-muted-foreground">{subtitle}</p>}
        </div>
        {children}
      </div>
    </main>
  );
}
