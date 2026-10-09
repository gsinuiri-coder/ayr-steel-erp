import { describe, expect, it } from 'vitest';
import {
  commitmentRows,
  lineNeed,
  linesLabel,
  lineStatus,
  type CommitmentInput,
} from './line-material';

const aMedida = {
  id: 'p-medida',
  name: 'Cobertura a medida',
  roofingKind: 'A_MEDIDA',
  unit: 'MTR',
  lengthMm: null,
} as const;
const plancha = {
  id: 'p-plancha',
  name: 'Plancha 3.60 m',
  roofingKind: 'PLANCHA',
  unit: 'NIU',
  lengthMm: '3600.00',
} as const;
const perfil = {
  id: 'p-perfil',
  name: 'Parante 64',
  roofingKind: null,
  unit: 'NIU',
  lengthMm: null,
} as const;
const rawStock = {
  availableQty: '0.000',
  unit: 'MTR',
  carriesInventory: true,
  kgPerMeter: '4.040',
  rawMaterialAvailableKg: '500.000',
  rawMaterialLabel: 'Bobina 0.50 mm Rojo',
};
const unitStock = {
  availableQty: '420.000',
  unit: 'NIU',
  carriesInventory: true,
  kgPerMeter: null,
  rawMaterialAvailableKg: null,
  rawMaterialLabel: null,
};

describe('lo que compromete una línea (cc36)', () => {
  it('a medida: kilos por metro por los metros de la línea', () => {
    const need = lineNeed({ kind: 'PRODUCT', qty: '10', product: aMedida, stock: rawStock });
    expect(need).toMatchObject({ kind: 'raw', label: 'Bobina 0.50 mm Rojo' });
    expect(need?.kind === 'raw' && need.needed?.toFixed(3)).toBe('40.400');
  });

  it('plancha: la cantidad son planchas y los metros salen del largo del SKU (D-171)', () => {
    const need = lineNeed({ kind: 'PRODUCT', qty: '10', product: plancha, stock: rawStock });
    // 10 planchas × 3.60 m × 4.040 kg/m
    expect(need?.kind === 'raw' && need.needed?.toFixed(3)).toBe('145.440');
  });

  it('servicio, stock, bobina y sin producto', () => {
    expect(
      lineNeed({
        kind: 'PRODUCT',
        qty: '1',
        product: perfil,
        stock: { ...unitStock, carriesInventory: false },
      }),
    ).toEqual({ kind: 'service' });
    expect(
      lineNeed({ kind: 'PRODUCT', qty: '5', product: perfil, stock: unitStock }),
    ).toMatchObject({ kind: 'stock', unit: 'NIU' });
    expect(lineNeed({ kind: 'PRODUCT', qty: '5', product: perfil })).toBeNull();
    expect(lineNeed({ kind: 'PRODUCT', qty: '5' })).toBeNull();
    expect(
      lineNeed({ kind: 'BOBINA', qty: '1200.000', coil: { coilId: 'c', code: 'BOB-1' } }),
    ).toMatchObject({ kind: 'coil', code: 'BOB-1' });
  });

  it('el estado dice alcanza o cuánto falta, con kilos a 2 decimales', () => {
    expect(
      lineStatus(lineNeed({ kind: 'PRODUCT', qty: '10', product: aMedida, stock: rawStock })),
    ).toEqual({ text: 'Reserva 40.40 kg · alcanza', tone: 'ok' });
    expect(
      lineStatus(lineNeed({ kind: 'PRODUCT', qty: '200', product: aMedida, stock: rawStock })),
    ).toEqual({ text: 'Reserva 808.00 kg · falta 308.00 kg', tone: 'short' });
    expect(
      lineStatus(lineNeed({ kind: 'PRODUCT', qty: '', product: aMedida, stock: rawStock })),
    ).toEqual({ text: 'Hay 500.00 kg de bobina', tone: 'neutral' });
    expect(
      lineStatus(
        lineNeed({
          kind: 'PRODUCT',
          qty: '1',
          product: aMedida,
          stock: { ...rawStock, rawMaterialAvailableKg: null },
        }),
      ),
    ).toEqual({ text: 'Sin dato de materia prima', tone: 'warning' });
    expect(
      lineStatus(lineNeed({ kind: 'PRODUCT', qty: '150', product: perfil, stock: unitStock })),
    ).toEqual({ text: 'De stock · hay 420 und', tone: 'ok' });
    expect(
      lineStatus(lineNeed({ kind: 'PRODUCT', qty: '500', product: perfil, stock: unitStock })),
    ).toEqual({ text: 'De stock · falta 80 und', tone: 'short' });
    expect(
      lineStatus(lineNeed({ kind: 'PRODUCT', qty: '', product: perfil, stock: unitStock })),
    ).toEqual({ text: 'De stock · hay 420 und', tone: 'neutral' });
    expect(lineStatus({ kind: 'service' })).toEqual({
      text: 'Servicio · sin inventario',
      tone: 'neutral',
    });
    expect(lineStatus(null)).toBeNull();
    expect(lineStatus({ kind: 'coil', qty: null, code: null })).toBeNull();
  });
});

describe('material que compromete al confirmar (cc36)', () => {
  const lines: CommitmentInput[] = [
    { lineNumber: 1, kind: 'PRODUCT', qty: '10', product: aMedida, stock: rawStock },
    { lineNumber: 2, kind: 'PRODUCT', qty: '10', product: plancha, stock: rawStock },
    { lineNumber: 3, kind: 'PRODUCT', qty: '150', product: perfil, stock: unitStock },
    { lineNumber: 4, kind: 'BOBINA', qty: '1200.000', coil: { coilId: 'c1', code: 'BOB-1' } },
    { lineNumber: 5, kind: 'PRODUCT', qty: '300', product: perfil, stock: unitStock },
    {
      lineNumber: 6,
      kind: 'PRODUCT',
      qty: '3',
      product: aMedida,
      stock: { ...rawStock, kgPerMeter: null },
    },
    { lineNumber: 7, kind: 'PRODUCT', qty: '', product: aMedida, stock: rawStock },
  ];

  it('suma por material y por producto, y aparta lo que no se puede calcular', () => {
    const { rows, missing } = commitmentRows(lines);
    expect(missing).toEqual([6]);
    expect(rows).toHaveLength(3);
    const [raw, stock, coil] = rows;
    expect(raw).toMatchObject({ kind: 'raw', label: 'Bobina 0.50 mm Rojo', lines: [1, 2] });
    expect(raw?.needed.toFixed(3)).toBe('185.840');
    expect(raw?.short).toBeNull();
    expect(stock).toMatchObject({ kind: 'stock', label: 'Parante 64', lines: [3, 5] });
    expect(stock?.short?.toFixed(3)).toBe('30.000');
    expect(coil).toMatchObject({ kind: 'coil', label: 'Bobina BOB-1', lines: [4], short: null });
  });

  it('nombra las líneas en castellano', () => {
    expect(linesLabel([3])).toBe('línea 3');
    expect(linesLabel([1, 2])).toBe('líneas 1 y 2');
    expect(linesLabel([1, 2, 4])).toBe('líneas 1, 2 y 4');
  });
});
