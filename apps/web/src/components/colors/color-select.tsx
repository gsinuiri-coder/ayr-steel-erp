'use client';

import { useQuery } from '@tanstack/react-query';
import type { ColorDto } from '@ayr/shared';
import { api } from '@/lib/api';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ColorSwatch } from './color-swatch';

/** Valor del selector cuando no hay color: `Select` de shadcn no admite `value=""`. */
export const NO_COLOR = 'sin-color';

export const colorsQueryKey = ['colors'] as const;

/** Colores del maestro. Una sola clave para toda la app, que es lo que hace que el alta de
 *  un color aparezca sin recargar en el catálogo, en la compra y en planta. */
export function useColors() {
  return useQuery({ queryKey: colorsQueryKey, queryFn: () => api<ColorDto[]>('/colors') });
}

interface Props {
  /** `''` o `NO_COLOR` = sin color. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Con `false`, el color es obligatorio y no se ofrece la opción "sin color". */
  allowEmpty?: boolean;
  placeholder?: string;
}

/**
 * Selector de color con muestra (D-085). Solo ofrece colores **activos**, más el que ya
 * estuviera elegido aunque se haya desactivado: si no, editar un producto viejo lo perdería
 * en silencio.
 */
export function ColorSelect({
  value,
  onChange,
  disabled,
  allowEmpty = true,
  placeholder = 'Sin color',
}: Props) {
  const colors = useColors();
  const current = colors.data?.find((c) => c.id === value) ?? null;
  const options = (colors.data ?? []).filter((c) => c.isActive || c.id === value);

  return (
    <Select
      value={value === '' ? NO_COLOR : value}
      onValueChange={(v) => {
        onChange(v === NO_COLOR ? '' : v);
      }}
      disabled={disabled === true || colors.isPending}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder}>
          {value === '' || value === NO_COLOR ? (
            placeholder
          ) : colors.isPending ? (
            'Cargando…'
          ) : (
            <ColorSwatch color={current} />
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {allowEmpty && <SelectItem value={NO_COLOR}>Sin color</SelectItem>}
        {options.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            <ColorSwatch color={c} />
          </SelectItem>
        ))}
        {options.length === 0 && (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            No hay colores cargados. Cárgalos en Catálogo → Colores.
          </p>
        )}
      </SelectContent>
    </Select>
  );
}
