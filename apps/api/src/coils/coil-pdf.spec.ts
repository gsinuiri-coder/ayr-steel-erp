import { equivalentMeters, type CoilDto } from '@ayr/shared';
import { coilsReportTable } from './coil-pdf';

/**
 * D-281: el PDF de la lista de bobinas suma el metro lineal teórico después del disponible y
 * conserva el ancho (la pantalla lo quitó; en papel no hay detalle al que ir a buscarlo).
 * D-356: ese metro lineal es el del **peso inicial**, rotulado «ML teórico (peso inicial)».
 */
describe('coilsReportTable (D-281, D-356)', () => {
  const geometry = { widthMm: '1220', thicknessMm: '0.50', densityFactor: '1' };
  const coil = {
    code: 'BOB-E2E-1',
    businessLine: 'drywall',
    colorName: null,
    widthMm: '1220.00',
    weightKg: '1000.000',
    // Ya se usó: el disponible es menor que el peso inicial.
    availableKg: '400.000',
    // El DTO trae los dos calculados por el API con la fórmula del dominio.
    equivalentMeters: equivalentMeters(geometry, '400.000')?.toFixed(3),
    initialMeters: equivalentMeters(geometry, '1000.000')?.toFixed(3),
    status: 'OPEN',
  } as unknown as CoilDto;
  const LABEL = 'ML teórico (peso inicial)';

  it('pone el metro lineal del peso inicial justo después del disponible y mantiene el ancho', () => {
    const table = coilsReportTable([coil]);
    const at = table.headers.indexOf('Disponible (kg)');
    expect(table.headers[at + 1]).toBe(LABEL);
    expect(table.headers).toContain('Ancho');
    // 1 000 kg ÷ (1.220 m × 0.50 mm × 1 × 1.01 de merma estándar) = 1 623.113 m: el del peso
    // inicial, no el de los 400 kg disponibles.
    expect(table.rows[0]?.[at + 1]).toBe('1623.113');
    expect(table.rows[0]?.[table.headers.indexOf('Ancho')]).toBe('1220.00 mm');
  });

  it('sin geometría no inventa un número', () => {
    const table = coilsReportTable([{ ...coil, initialMeters: null }]);
    expect(table.rows[0]?.[table.headers.indexOf(LABEL)]).toBe('—');
  });

  it('las columnas entran en el ancho útil de un A4 (595 − 2 × 48)', () => {
    const { widths, headers } = coilsReportTable([]);
    expect(widths).toHaveLength(headers.length);
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(595 - 96);
  });
});
