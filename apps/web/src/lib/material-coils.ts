import {
  Decimal,
  toDecimal,
  toFixedString,
  type SalesMaterialKind,
  type SalesMaterialRowDto,
} from '@ayr/shared';

/**
 * D-354: el modal «cuántas bobinas» de Ventas por material. «Sumado» da una fila por bobina;
 * «Desglosado», una por bobina × tipo. Sale de las bobinas que cada fila ya trae, así que la
 * pantalla y el Excel (hoja «Bobinas por tipo») cuentan lo mismo.
 */
export type CoilView = 'sum' | 'split';

export interface MaterialCoilLine {
  key: string;
  coilId: string;
  code: string;
  thicknessMm: string;
  colorLabel: string;
  /** Solo en «Desglosado». */
  kind: SalesMaterialKind | null;
  kg: string;
  costPen: string;
}

export function materialCoils(
  rows: readonly SalesMaterialRowDto[],
  view: CoilView,
): MaterialCoilLine[] {
  const acc = new Map<
    string,
    Omit<MaterialCoilLine, 'kg' | 'costPen'> & { kg: Decimal; cost: Decimal }
  >();
  for (const row of rows) {
    for (const coil of row.coils) {
      const key = view === 'sum' ? coil.coilId : `${coil.coilId}|${row.kind}`;
      const found = acc.get(key) ?? {
        key,
        coilId: coil.coilId,
        code: coil.code,
        thicknessMm: coil.thicknessMm,
        colorLabel: coil.colorLabel,
        kind: view === 'sum' ? null : row.kind,
        kg: new Decimal(0),
        cost: new Decimal(0),
      };
      found.kg = found.kg.plus(toDecimal(coil.kg));
      found.cost = found.cost.plus(toDecimal(coil.costPen));
      acc.set(key, found);
    }
  }
  return [...acc.values()]
    .sort((a, b) => a.code.localeCompare(b.code) || (a.kind ?? '').localeCompare(b.kind ?? ''))
    .map(({ kg, cost, ...rest }) => ({
      ...rest,
      kg: toFixedString(kg, 'KG'),
      costPen: toFixedString(cost, 'MONEY'),
    }));
}
