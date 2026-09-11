'use client';

import { useState } from 'react';
import { businessToday, Role } from '@ayr/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSession } from '@/lib/session';

/**
 * Fecha de operación (D-124): el día de negocio al que pertenece lo que se está
 * registrando. Por defecto **hoy**, y por eso el campo arranca colapsado detrás de un
 * enlace discreto: el flujo de todos los días no lo abre nunca y no gana un input más.
 *
 * Solo lo ve un ADMINISTRADOR. Un VENDEDOR ni siquiera lo tiene en pantalla, y si lo
 * mandara igual el API le responde 403: retrofechar es la superficie por la que una venta
 * o un despacho se mueven de mes, y no es una atribución suya.
 */
export function OperationDateField({
  value,
  onChange,
  label = 'Fecha de operación',
  hint = 'Solo para carga histórica. Por defecto, hoy.',
}: {
  /** `YYYY-MM-DD`, o `undefined` para "hoy" (el caso normal: no se manda el campo). */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  label?: string;
  hint?: string;
}) {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  if (user.role !== Role.ADMINISTRADOR) return null;

  const today = businessToday();
  if (!open) {
    return (
      <button
        type="button"
        className="justify-self-start text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        onClick={() => {
          setOpen(true);
        }}
      >
        {value && value !== today ? `${label}: ${value}` : `Cambiar ${label.toLowerCase()}`}
      </button>
    );
  }

  return (
    <div className="space-y-1">
      <Label htmlFor="operation-date">{label}</Label>
      <Input
        id="operation-date"
        type="date"
        max={today}
        value={value ?? today}
        onChange={(e) => {
          // Cadena vacía = el usuario borró el campo: vuelve a "hoy" sin mandar nada.
          const next = e.target.value;
          onChange(next === '' || next === today ? undefined : next);
        }}
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
