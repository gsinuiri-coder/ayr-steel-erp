'use client';

import { Button } from '@/components/ui/button';

/**
 * cc32: un grupo de botones excluyentes de un reporte (los atajos del periodo, «Ver por»). Cada
 * opción es un botón con `aria-pressed`, como `FilterChip`: se opera con teclado y el activo se
 * distingue también sin color (va relleno).
 */
export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
  showLabel = false,
}: {
  /** Nombre del grupo para lectores de pantalla («Periodo», «Ver por»). */
  label: string;
  value: V | null;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
  /** Muestra el nombre del grupo delante de las opciones. */
  showLabel?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {showLabel && <span className="text-xs text-muted-foreground">{label}</span>}
      <div
        role="group"
        aria-label={label}
        className="inline-flex flex-wrap items-center gap-0.5 rounded-md border bg-muted/40 p-0.5"
      >
        {options.map((o) => (
          <Button
            key={o.value}
            type="button"
            size="sm"
            variant={value === o.value ? 'secondary' : 'ghost'}
            aria-pressed={value === o.value}
            className={value === o.value ? 'bg-background shadow-xs' : 'text-muted-foreground'}
            onClick={() => {
              onChange(o.value);
            }}
          >
            {o.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
