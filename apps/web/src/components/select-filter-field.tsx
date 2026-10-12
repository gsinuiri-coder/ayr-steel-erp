'use client';

import { FilterField } from '@/components/table-toolbar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** El valor interno de «todos» del selector (Radix no admite un `value` vacío en un ítem). */
const ALL = 'ALL';

/**
 * cc47 (D-615): un selector del modal «Filtros» con su rótulo arriba y la opción «todos» primero.
 * `value` vacío (o `allValue`, si la vista usa otro centinela en la URL) es «todos».
 */
export function SelectFilterField({
  id,
  label,
  value,
  onChange,
  allLabel,
  options,
  allValue = '',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** «Todas las líneas», «Todos los tipos»… */
  allLabel: string;
  options: readonly { value: string; label: string }[];
  /** Lo que la vista guarda para «todos»: vacío por defecto. */
  allValue?: string;
}) {
  return (
    <FilterField label={label} htmlFor={id}>
      <Select
        value={value === allValue || value === '' ? ALL : value}
        onValueChange={(v) => {
          onChange(v === ALL ? allValue : v);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FilterField>
  );
}
