'use client';

import { FilterChip } from '@/components/filter-chip';
import { FilterField, FiltersDialog } from '@/components/table-toolbar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ALL = 'ALL';

/**
 * D-289: el filtro de estado común de las listas. Un selector con los estados que **siguen en
 * juego** y, aparte, el chip de los terminales negativos («Anulados», «Revertidos»…).
 *
 * `value` es el parámetro `status` de la URL: vacío = el default del servidor (todo salvo los
 * terminales negativos); una lista separada por comas = esos estados. El chip activo pide
 * **solo** los negativos (`negativeValue`) y el selector pide un solo estado; elegir uno
 * desactiva al otro.
 */
export function StatusFilter({
  value,
  onChange,
  options,
  negativeValue,
  negativeLabel = 'Anulados',
  allLabel = 'Todos, sin anulados',
  className = 'w-56',
}: {
  value: string;
  onChange: (value: string) => void;
  /** Los estados que aparecen en el selector: los que no son terminales negativos. */
  options: readonly { value: string; label: string }[];
  /** Estados del chip, separados por coma (`VOIDED,ANNULLED`). */
  negativeValue: string;
  negativeLabel?: string;
  allLabel?: string;
  className?: string;
}) {
  const negativeActive = value === negativeValue;
  const selectValue = !negativeActive && options.some((o) => o.value === value) ? value : ALL;
  return (
    <>
      <Select
        value={selectValue}
        onValueChange={(v) => {
          onChange(v === ALL ? '' : v);
        }}
      >
        <SelectTrigger className={className} aria-label="Estado">
          <SelectValue placeholder="Estado" />
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
      <FilterChip
        active={negativeActive}
        onToggle={() => {
          onChange(negativeActive ? '' : negativeValue);
        }}
      >
        {negativeLabel}
      </FilterChip>
    </>
  );
}

/**
 * cc47 (D-615): el botón «Filtros» de una lista cuyo único filtro es el estado. El modal lleva el
 * mismo `StatusFilter` (selector y chip), sobre un borrador que se aplica con «Aplicar».
 */
export function StatusFiltersButton({
  value,
  onApply,
  ...filter
}: {
  value: string;
  onApply: (status: string) => void;
  options: readonly { value: string; label: string }[];
  negativeValue: string;
  negativeLabel?: string;
  allLabel?: string;
}) {
  return (
    <FiltersDialog<{ status: string }>
      value={{ status: value }}
      empty={{ status: '' }}
      activeCount={value === '' ? 0 : 1}
      onApply={(next) => {
        onApply(next.status);
      }}
    >
      {(draft, update) => (
        <FilterField label="Estado">
          <div className="flex flex-wrap items-center gap-2">
            <StatusFilter
              {...filter}
              value={draft.status}
              onChange={(status) => {
                update({ status });
              }}
            />
          </div>
        </FilterField>
      )}
    </FiltersDialog>
  );
}
