'use client';

import { Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * S10b/M2: una nota informativa estática (no un aviso de negocio condicional — esos
 * siguen siempre visibles) que por defecto ocupaba layout permanente. El ícono ⓘ es
 * `<button>`, así que hereda foco por teclado y `Escape` para cerrar de Radix `Popover`
 * sin nada adicional.
 */
export function InfoPopover({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Info className="size-4" aria-hidden />
      </PopoverTrigger>
      <PopoverContent>{children}</PopoverContent>
    </Popover>
  );
}
