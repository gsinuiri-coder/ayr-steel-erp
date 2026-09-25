'use client';

import { Button } from '@/components/ui/button';

/**
 * D-289: interruptor de filtro de una lista («Anulados», «Atendidos»). Un botón con
 * `aria-pressed`, no un `Badge`: se opera con teclado y se distingue activo/inactivo también
 * sin color (el activo va relleno).
 */
export function FilterChip({
  active,
  onToggle,
  children,
}: {
  active: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? 'default' : 'outline'}
      aria-pressed={active}
      className="rounded-full"
      onClick={onToggle}
    >
      {children}
    </Button>
  );
}
