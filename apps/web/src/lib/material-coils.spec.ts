import { describe, expect, it } from 'vitest';
import type { SalesMaterialRowDto } from '@ayr/shared';
import { materialCoils } from './material-coils';

const figures = {
  metersSold: '0.000',
  theoreticalKg: '0.000',
  realKg: '0.000',
  yieldKg: '0.000',
  yieldPct: null,
  salesPen: '0.0000',
  costPen: '0.0000',
  profitPen: '0.0000',
  costPerKgPen: null,
  pricePerKgPen: null,
  marginPerKgPen: null,
  pricePerMeterPen: null,
  costPerMeterPen: null,
  marginPerMeterPen: null,
  unit: null,
  qty: null,
  costPerUnitPen: null,
};

const coil = (id: string, kg: string, cost: string) => ({
  coilId: id,
  code: `B-${id}`,
  thicknessMm: '0.38',
  colorLabel: 'ROJO',
  kg,
  costPen: cost,
});

const ROWS: SalesMaterialRowDto[] = [
  {
    kind: 'COBERTURA',
    thicknessMm: '0.40',
    colorLabel: 'ROJO',
    lineCount: 1,
    ...figures,
    coils: [coil('1', '10.000', '25.0000'), coil('2', '5.000', '12.5000')],
  },
  {
    kind: 'ACCESORIO',
    thicknessMm: '0.40',
    colorLabel: 'ROJO',
    lineCount: 1,
    ...figures,
    coils: [coil('1', '2.500', '6.2500')],
  },
];

describe('materialCoils (D-354)', () => {
  it('«Sumado»: una fila por bobina, con los kilos y el costo de todas las filas', () => {
    expect(materialCoils(ROWS, 'sum').map((c) => [c.code, c.kind, c.kg, c.costPen])).toEqual([
      ['B-1', null, '12.500', '31.2500'],
      ['B-2', null, '5.000', '12.5000'],
    ]);
  });

  it('«Desglosado»: bobina × tipo, con el espesor de la bobina y no el del producto', () => {
    const split = materialCoils(ROWS, 'split');
    expect(split.map((c) => [c.code, c.kind, c.kg])).toEqual([
      ['B-1', 'ACCESORIO', '2.500'],
      ['B-1', 'COBERTURA', '10.000'],
      ['B-2', 'COBERTURA', '5.000'],
    ]);
    expect(split[0]?.thicknessMm).toBe('0.38');
  });
});
