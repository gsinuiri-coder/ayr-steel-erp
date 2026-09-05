import {
  DEFAULT_QUOTATION_VALIDITY_DAYS,
  defaultValidUntil,
  IGV_RATE_PCT,
  queueSemaphore,
  salesLineTotals,
  salesTotals,
} from '@ayr/shared';
import { documentTotals, type ResolvedSalesLine } from './sales-lines';

/**
 * Aritmética del ciclo comercial (D-064, D-068). Todo en soles, sin IGV en el precio
 * unitario y con el IGV separado; nada se opera con `number` (D-003).
 */

function line(overrides: Partial<ResolvedSalesLine>): ResolvedSalesLine {
  return {
    lineNumber: 1,
    productId: 'p1',
    description: 'Perfil',
    qty: '1.000',
    unit: 'NIU',
    listPricePen: null,
    unitPricePen: '0.0000',
    subtotalPen: '0.0000',
    igvPen: '0.0000',
    totalPen: '0.0000',
    reserveItemType: 'PRODUCT',
    reserveItemId: 'p1',
    reserveQty: '1.000',
    reserveUnit: 'NIU',
    productSku: 'SKU',
    productName: 'Perfil',
    pieces: [],
    reserveItemLabel: 'SKU',
    ...overrides,
  };
}

describe('salesLineTotals (D-068)', () => {
  it('aplica IGV del 18% sobre el subtotal sin IGV', () => {
    const totals = salesLineTotals({ qty: '10.000', unitPricePen: '25.0000' });
    expect(totals.subtotal.toFixed(4)).toBe('250.0000');
    expect(totals.igv.toFixed(4)).toBe('45.0000');
    expect(totals.total.toFixed(4)).toBe('295.0000');
  });

  it('el IGV es el declarado en la constante, no un número suelto', () => {
    expect(IGV_RATE_PCT).toBe('18.0000');
  });

  it('redondea a la escala de dinero en cada paso, no al final', () => {
    // 3.333 × 7.7777 = 25.9230741 → 25.9231 de subtotal, y el IGV sale de ese redondeo
    // (25.9231 × 0.18 = 4.666158 → 4.6662), no del producto sin redondear.
    const totals = salesLineTotals({ qty: '3.333', unitPricePen: '7.7777' });
    expect(totals.subtotal.toFixed(4)).toBe('25.9231');
    expect(totals.igv.toFixed(4)).toBe('4.6662');
    expect(totals.total.toFixed(4)).toBe('30.5893');
  });

  it('una cantidad con decimales de kilo no pierde precisión (D-003)', () => {
    const totals = salesLineTotals({ qty: '1250.500', unitPricePen: '4.3000' });
    expect(totals.subtotal.toFixed(4)).toBe('5377.1500');
  });
});

describe('salesTotals y documentTotals (D-068)', () => {
  it('el total del documento es Σ subtotales + Σ IGV, no Σ de totales redondeados', () => {
    const lines = [
      { qty: '1.000', unitPricePen: '0.0100' },
      { qty: '1.000', unitPricePen: '0.0100' },
      { qty: '1.000', unitPricePen: '0.0100' },
    ];
    const totals = salesTotals(lines);
    expect(totals.subtotal.toFixed(4)).toBe('0.0300');
    // Cada línea aporta 0.0018 de IGV; sumar los tres IGV de línea da 0.0054.
    expect(totals.igv.toFixed(4)).toBe('0.0054');
    expect(totals.total.toFixed(4)).toBe('0.0354');
  });

  it('documentTotals suma las líneas ya resueltas con la misma regla', () => {
    const totals = documentTotals([
      line({ subtotalPen: '250.0000', igvPen: '45.0000', totalPen: '295.0000' }),
      line({ lineNumber: 2, subtotalPen: '100.5000', igvPen: '18.0900', totalPen: '118.5900' }),
    ]);
    expect(totals).toEqual({
      subtotalPen: '350.5000',
      igvPen: '63.0900',
      totalPen: '413.5900',
    });
  });

  it('un documento de una sola línea coincide con el total de esa línea', () => {
    const one = salesLineTotals({ qty: '7.000', unitPricePen: '13.3300' });
    const doc = documentTotals([
      line({
        subtotalPen: one.subtotal.toFixed(4),
        igvPen: one.igv.toFixed(4),
        totalPen: one.total.toFixed(4),
      }),
    ]);
    expect(doc.totalPen).toBe(one.total.toFixed(4));
  });
});

describe('defaultValidUntil (D-069)', () => {
  it('suma los días de vigencia a la fecha de emisión', () => {
    expect(defaultValidUntil('2026-09-03', 7)).toBe('2026-09-10');
  });

  it('el default son 7 días', () => {
    expect(DEFAULT_QUOTATION_VALIDITY_DAYS).toBe(7);
    expect(defaultValidUntil('2026-09-03')).toBe('2026-09-10');
  });

  it('cruza el fin de mes y el fin de año sin desbordar', () => {
    expect(defaultValidUntil('2026-01-30', 5)).toBe('2026-02-04');
    expect(defaultValidUntil('2026-12-28', 10)).toBe('2027-01-07');
  });

  it('un año bisiesto suma el 29 de febrero', () => {
    expect(defaultValidUntil('2028-02-27', 3)).toBe('2028-03-01');
  });
});

describe('queueSemaphore (D-096)', () => {
  const today = '2026-09-10';

  it('sin fecha prometida, sin fecha', () => {
    expect(queueSemaphore(null, today)).toBe('SIN_FECHA');
  });

  it('una fecha pasada está vencida', () => {
    expect(queueSemaphore('2026-09-09', today)).toBe('VENCIDO');
  });

  it('hoy o mañana es próximo: el proxy de calendario de "menos de 48 h"', () => {
    expect(queueSemaphore('2026-09-10', today)).toBe('PROXIMO');
    expect(queueSemaphore('2026-09-11', today)).toBe('PROXIMO');
  });

  it('pasado mañana en adelante está a tiempo', () => {
    expect(queueSemaphore('2026-09-12', today)).toBe('A_TIEMPO');
  });

  it('cruza el fin de mes sin desbordar', () => {
    expect(queueSemaphore('2026-10-01', '2026-09-30')).toBe('PROXIMO');
  });
});
