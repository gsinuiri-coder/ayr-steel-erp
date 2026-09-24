import { toDecimal } from '@ayr/shared';

/**
 * D-282: lógica pura del modal de venta de bobina entera. El pool es el mismo corte que el de
 * venta de bobina (D-253): espesor + color comercial; una bobina sin color cae en su acabado.
 */
export interface PickerCoil {
  code: string;
  thicknessMm: string;
  colorName: string | null;
  finishName: string;
  finishCode: string;
}

export function coilPoolLabel(coil: PickerCoil): string {
  return `${coil.thicknessMm} mm · ${coil.colorName ?? coil.finishName}`;
}

export function groupByPool<T extends PickerCoil>(
  coils: readonly T[],
): { label: string; coils: T[] }[] {
  const sorted = [...coils].sort(
    (a, b) =>
      toDecimal(a.thicknessMm).comparedTo(toDecimal(b.thicknessMm)) ||
      coilPoolLabel(a).localeCompare(coilPoolLabel(b)) ||
      a.code.localeCompare(b.code),
  );
  const groups: { label: string; coils: T[] }[] = [];
  for (const coil of sorted) {
    const label = coilPoolLabel(coil);
    const last = groups.at(-1);
    if (last?.label === label) last.coils.push(coil);
    else groups.push({ label, coils: [coil] });
  }
  return groups;
}

export function matchesCoilFilter(coil: PickerCoil, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return true;
  return [coil.code, coil.colorName ?? '', coil.finishName, coil.finishCode, coil.thicknessMm]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}
