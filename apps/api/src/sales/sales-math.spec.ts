import {
  Decimal,
  DEFAULT_QUOTATION_VALIDITY_DAYS,
  defaultValidUntil,
  fixedLengthMeters,
  fixedLengthUnitValue,
  fixedLengthValuePerMeter,
  IGV_RATE_PCT,
  isQuotationExpired,
  listValueForPlancha,
  money,
  piecesMeters,
  quotationValidUntil,
  queueSemaphore,
  roundDocumentTotals,
  salePriceFromValue,
  saleValueFromPrice,
  salesLineTotals,
  salesTotals,
  toFixedString,
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
    businessLineId: 'line1',
    description: 'Perfil',
    qty: '1.000',
    unit: 'NIU',
    listPricePen: null,
    unitPricePen: '0.0000',
    valuePerMeterPen: null,
    piecesHint: null,
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

  it('un documento de una sola línea es esa línea redondeada al céntimo (D-377)', () => {
    // 7 × 13.33 = 93.31 de valor; la línea guarda 16.7958 de IGV y 110.1058 de total, el
    // documento 16.80 y 110.11.
    const one = salesLineTotals({ qty: '7.000', unitPricePen: '13.3300' });
    expect(one.total.toFixed(4)).toBe('110.1058');
    const doc = documentTotals([
      line({
        subtotalPen: one.subtotal.toFixed(4),
        igvPen: one.igv.toFixed(4),
        totalPen: one.total.toFixed(4),
      }),
    ]);
    expect(doc).toEqual({ subtotalPen: '93.3100', igvPen: '16.8000', totalPen: '110.1100' });
  });
});

/**
 * D-377 (R2): el documento se redondea al céntimo **una sola vez**, al final: gravada =
 * céntimo(Σ valor), IGV = céntimo(Σ valor × 18 %), total = gravada + IGV. La línea no se toca.
 * Los totales esperados son fijos, los de la tabla del GATE (docs/analisis/decimales-p14).
 */
describe('roundDocumentTotals (D-377, R2)', () => {
  const docOf = (...units: string[]) =>
    documentTotals(
      units.map((unitPricePen, i) => {
        const t = salesLineTotals({ qty: '1.000', unitPricePen });
        return line({
          lineNumber: i + 1,
          unitPricePen,
          subtotalPen: t.subtotal.toFixed(4),
          igvPen: t.igv.toFixed(4),
          totalPen: t.total.toFixed(4),
        });
      }),
    );

  it('tres líneas de valor 10.01 dan 35.44 (IGV céntimo(5.4054) = 5.41), no 35.43 ni 35.4354', () => {
    expect(docOf('10.0100', '10.0100', '10.0100')).toEqual({
      subtotalPen: '30.0300',
      igvPen: '5.4100',
      totalPen: '35.4400',
    });
  });

  it('una línea de valor 10.01 da 11.81 (antes 11.8118)', () => {
    expect(docOf('10.0100')).toEqual({
      subtotalPen: '10.0100',
      igvPen: '1.8000',
      totalPen: '11.8100',
    });
  });

  it('20 planchas a 98.0001 dan 2,312.80 (antes 2,312.8024)', () => {
    const t = salesLineTotals({ qty: '20.000', unitPricePen: '98.0001' });
    expect(t.total.toFixed(4)).toBe('2312.8024');
    expect(roundDocumentTotals(t.subtotal, t.igv).total.toFixed(2)).toBe('2312.80');
  });

  it('146 × 16.28928 da 2,806.31: gravada 2,378.23 + IGV 428.08 (la línea sigue en 2,806.3172)', () => {
    const t = salesLineTotals({ qty: '146.000', unitPricePen: '16.28928' });
    expect(t.subtotal.toFixed(4)).toBe('2378.2349');
    expect(t.total.toFixed(4)).toBe('2806.3172');
    const doc = roundDocumentTotals(t.subtotal, t.igv);
    expect([doc.subtotal.toFixed(2), doc.igv.toFixed(2), doc.total.toFixed(2)]).toEqual([
      '2378.23',
      '428.08',
      '2806.31',
    ]);
  });

  it('medio céntimo sube (HALF_UP), en la gravada y en el IGV', () => {
    // Gravada 10.005 → 10.01; IGV 1.8009 → 1.80.
    expect(docOf('10.0050')).toEqual({
      subtotalPen: '10.0100',
      igvPen: '1.8000',
      totalPen: '11.8100',
    });
    // IGV 0.25 × 18 % = 0.045 exacto → 0.05.
    expect(docOf('0.2500')).toEqual({
      subtotalPen: '0.2500',
      igvPen: '0.0500',
      totalPen: '0.3000',
    });
    // Por debajo del medio céntimo baja: 0.2497 × 18 % = 0.044946 → línea 0.0449 → 0.04.
    expect(docOf('0.2497').igvPen).toBe('0.0400');
  });

  it('el IGV suma los IGV de línea: una línea con el trío del papel conserva su IGV (D-255)', () => {
    // Papel con valor 100.00, IGV 18.01 (IGV como resta) y total 118.01: la cabecera es la del
    // papel. Recalcular Σ valor × 18 % daba 118.00 y el cobro de 118.01 se rechazaba por exceso.
    const doc = documentTotals([
      line({ subtotalPen: '100.0000', igvPen: '18.0100', totalPen: '118.0100' }),
    ]);
    expect(doc).toEqual({ subtotalPen: '100.0000', igvPen: '18.0100', totalPen: '118.0100' });
  });

  it('B1: una plancha cotizada al valor por metro de lista vale la lista exacta', () => {
    // Lista 98.00 la plancha de 3 m → 32.6667 por metro (así lo siembra el formulario).
    const perMeter = money(fixedLengthValuePerMeter('3000.00', '98.0000')).toFixed(4);
    expect(perMeter).toBe('32.6667');
    expect(listValueForPlancha('3000.00', perMeter, '98.0000').toFixed(4)).toBe('98.0000');
    // Sin lista, o con otro valor por metro, la cuenta de siempre: largo × valor por metro.
    expect(listValueForPlancha('3000.00', perMeter, null).toFixed(4)).toBe('98.0001');
    expect(listValueForPlancha('3000.00', '32.6668', '98.0000').toFixed(4)).toBe('98.0004');
  });

  it('un total en céntimos es idempotente: volver a redondearlo no lo mueve', () => {
    const once = roundDocumentTotals('2378.2349', '428.0823');
    expect(roundDocumentTotals(once.subtotal, once.igv).total.equals(once.total)).toBe(true);
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

/**
 * D-157 — la cotización **sin vencimiento**.
 *
 * `null` no es "falta el dato" ni "vence hoy": es "no vence". Lo pide el importador (D-152),
 * que carga comprobantes ya vendidos; con la vigencia por defecto sobre una emisión de agosto,
 * las 71 cotizaciones nacían vencidas y ninguna se podía confirmar.
 *
 * El centinela de verdad es `isQuotationExpired`: es la **única** función que responde la
 * pregunta, y existe justamente porque la forma natural de escribirla suelta —`validUntil <
 * hoy`— convierte el `null` en `'' < hoy`, o sea en vencida para siempre, y sin que nada avise.
 */
describe('cotización sin vencimiento (D-157)', () => {
  it('con días de vigencia, `quotationValidUntil` es el `defaultValidUntil` de siempre', () => {
    expect(quotationValidUntil('2026-09-03', 7)).toBe('2026-09-10');
    expect(quotationValidUntil('2026-09-03', 30)).toBe('2026-10-03');
  });

  it('`null` días es `null` fecha: no se inventa ninguna', () => {
    expect(quotationValidUntil('2026-08-03', null)).toBeNull();
  });

  it('sin vencimiento nunca está vencida, por vieja que sea la emisión', () => {
    // El caso exacto del importador: un comprobante de agosto cargado en septiembre.
    expect(isQuotationExpired(null, '2026-09-09')).toBe(false);
    expect(isQuotationExpired(null, '2099-01-01')).toBe(false);
  });

  it('con fecha, vence el día siguiente al último válido', () => {
    expect(isQuotationExpired('2026-09-10', '2026-09-10')).toBe(false);
    expect(isQuotationExpired('2026-09-10', '2026-09-11')).toBe(true);
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

describe('D-162 — valor de venta (sin IGV) y precio de venta (con IGV)', () => {
  it('el valor sale del precio dividiendo por 1.18, sin redondear en el camino', () => {
    // El ejemplo del enunciado: precio 10.00 → valor 8.474576271186…
    expect(saleValueFromPrice('10.00').toFixed(6)).toBe('8.474576');
    expect(toFixedString(money(saleValueFromPrice('10.00')), 'MONEY')).toBe('8.4746');
  });

  it('ida y vuelta: el precio de un valor vuelve a ser el precio', () => {
    expect(salePriceFromValue('8.4746').toFixed(4)).toBe('10.0000');
    expect(salePriceFromValue(saleValueFromPrice('123.45')).toFixed(2)).toBe('123.45');
  });

  it('el IGV que separa los dos es el mismo de la línea, no un número suelto', () => {
    const value = saleValueFromPrice('118.00');
    expect(value.toFixed(4)).toBe('100.0000');
    expect(salesLineTotals({ qty: '1.000', unitPricePen: value }).total.toFixed(4)).toBe(
      '118.0000',
    );
  });
});

describe('D-161 — la plancha cotiza por metro; la cobertura a medida, también (lado a lado)', () => {
  // Una plancha de catálogo de 3.60 m y una cobertura a medida de la misma línea, cotizadas
  // las dos a S/ 7.00 el metro sin IGV. Es el par que hace visible la diferencia: la plancha
  // cuenta en planchas y la a medida cuenta en metros, y aun así el importe por metro es el
  // mismo.
  const LARGO_MM = '3600.00';
  const VALOR_METRO = '7.0000';

  it('plancha: 10 planchas de 3.60 m a S/ 7.00 el metro son 36 ML y S/ 252.00 de valor', () => {
    const unitario = toFixedString(money(fixedLengthUnitValue(LARGO_MM, VALOR_METRO)), 'MONEY');
    expect(unitario).toBe('25.2000');
    expect(fixedLengthMeters(LARGO_MM, '10').toFixed(3)).toBe('36.000');
    const totals = salesLineTotals({ qty: '10.000', unitPricePen: unitario });
    expect(totals.subtotal.toFixed(4)).toBe('252.0000');
    expect(totals.total.toFixed(4)).toBe('297.3600');
  });

  it('a medida: 10 planchas de 3.60 m a S/ 7.00 el metro dan el mismo importe, en metros', () => {
    const pieces = [{ lengthMm: LARGO_MM, qty: 10 }];
    expect(piecesMeters(pieces).toFixed(3)).toBe('36.000');
    const totals = salesLineTotals({ qty: '36.000', unitPricePen: VALOR_METRO });
    expect(totals.subtotal.toFixed(4)).toBe('252.0000');
    expect(totals.total.toFixed(4)).toBe('297.3600');
  });

  it('la cuenta vieja —cantidad × valor directo— daba una plancha por el precio de un metro', () => {
    // Lo que D-161 vino a corregir: con 10 planchas a S/ 7.00 el importe salía S/ 70.00, o
    // sea 3.6 veces menos de lo cotizado. El factor es exactamente el largo del SKU.
    const viejo = salesLineTotals({ qty: '10.000', unitPricePen: VALOR_METRO });
    expect(viejo.subtotal.toFixed(4)).toBe('70.0000');
    expect(new Decimal('252.0000').div(viejo.subtotal).toFixed(2)).toBe('3.60');
  });

  it('el camino inverso recupera el valor por metro de un valor por plancha', () => {
    expect(fixedLengthValuePerMeter(LARGO_MM, '25.2000').toFixed(4)).toBe('7.0000');
  });

  it('un largo que no divide redondo no arrastra el redondeo al importe', () => {
    // 4.13 m a S/ 7.7777 el metro: 32.1219 por plancha (32.12189… redondeado una sola vez).
    const unitario = toFixedString(money(fixedLengthUnitValue('4130.00', '7.7777')), 'MONEY');
    expect(unitario).toBe('32.1219');
  });
});
