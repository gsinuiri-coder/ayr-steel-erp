import type { ColorDto } from '@ayr/shared';
import { cn } from '@/lib/utils';

/**
 * La muestra de color (D-085). Existe porque en planta el rollo se elige **por lo que se
 * ve**: un nombre no distingue dos rojos, y montar el que no era es el error que ningún
 * guardrail de base de datos puede atrapar.
 *
 * El nombre acompaña siempre a la muestra, nunca la reemplaza: el color solo no es
 * accesible para quien no lo distingue.
 */
export function ColorSwatch({
  color,
  className,
}: {
  color: Pick<ColorDto, 'name' | 'hexColor'> | null;
  className?: string;
}) {
  if (!color) {
    return <span className={cn('text-muted-foreground', className)}>Sin color</span>;
  }
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span
        aria-hidden
        className="size-4 shrink-0 rounded-sm border border-border"
        style={{ backgroundColor: color.hexColor }}
      />
      <span>{color.name}</span>
    </span>
  );
}
