import { Decimal } from '@ayr/shared';
import {
  asText,
  isDecimalText,
  mismatchedHeaderLabels,
  SALES_HISTORY_TOTAL_TOLERANCE_PEN,
  salesHistoryTotalMismatch,
  totalMismatch,
  totalTolerance,
} from './fiscal-import-math';

/**
 * Las tres comprobaciones de grupo de RF-71. Se prueban acá y no contra la base porque son
 * puras: lo que decide si un comprobante importado entra bien o entra mal no es una
 * consulta, es esta aritmética.
 */

const HEADER_FIELDS = [
  { key: 'docType', label: 'el tipo' },
  { key: 'issueDate', label: 'la fecha de emisión' },
  { key: 'totalPen', label: 'el total' },
] as const;

describe('asText', () => {
  it('devuelve el texto tal cual y numeriza lo que la planilla trae como número', () => {
    expect(asText('F001')).toBe('F001');
    expect(asText(123)).toBe('123');
    expect(asText(true)).toBe('true');
  });

  it('no convierte objetos ni nulos: dos cabeceras distintas no pueden parecer iguales', () => {
    expect(asText({ a: 1 })).toBe('');
    expect(asText(null)).toBe('');
    expect(asText(undefined)).toBe('');
  });
});

describe('isDecimalText', () => {
  it('acepta lo que `toDecimal` sabe leer', () => {
    expect(isDecimalText('118.0000')).toBe(true);
    expect(isDecimalText('2')).toBe(true);
    expect(isDecimalText('-3.5')).toBe(true);
  });

  it('rechaza lo que una fila inválida conserva sin normalizar', () => {
    // Es el caso que importa: sin este filtro, "abc" en Cantidad llegaba a `toDecimal`,
    // que lanza, y la subida terminaba en un 500 en vez de en una fila marcada en rojo.
    expect(isDecimalText('abc')).toBe(false);
    expect(isDecimalText('')).toBe(false);
    expect(isDecimalText('1,5')).toBe(false);
    expect(isDecimalText('1e3')).toBe(false);
    expect(isDecimalText(118)).toBe(false);
    expect(isDecimalText(null)).toBe(false);
  });
});

describe('totalTolerance', () => {
  it('es un céntimo por línea', () => {
    expect(totalTolerance(1).toString()).toBe('0.01');
    expect(totalTolerance(6).toString()).toBe('0.06');
  });

  it('nunca es cero: un comprobante sin líneas todavía tolera el céntimo del redondeo', () => {
    expect(totalTolerance(0).toString()).toBe('0.01');
  });
});

describe('mismatchedHeaderLabels', () => {
  it('no reporta nada cuando todas las filas repiten la misma cabecera', () => {
    const rows = [
      { docType: 'FACTURA', issueDate: '2026-09-01', totalPen: '118.0000' },
      { docType: 'FACTURA', issueDate: '2026-09-01', totalPen: '118.0000' },
    ];
    expect(mismatchedHeaderLabels(rows, HEADER_FIELDS)).toEqual([]);
  });

  it('nombra cada campo que cambia a mitad del comprobante', () => {
    const rows = [
      { docType: 'FACTURA', issueDate: '2026-09-01', totalPen: '118.0000' },
      { docType: 'BOLETA', issueDate: '2026-09-02', totalPen: '118.0000' },
    ];
    expect(mismatchedHeaderLabels(rows, HEADER_FIELDS)).toEqual(['el tipo', 'la fecha de emisión']);
  });

  it('trata "vacío" y "ausente" como lo mismo: una columna opcional en blanco no es un cambio', () => {
    const rows = [{ dueDate: '' }, {}];
    expect(mismatchedHeaderLabels(rows, [{ key: 'dueDate', label: 'el vencimiento' }])).toEqual([]);
  });
});

describe('totalMismatch', () => {
  it('acepta el total exacto', () => {
    const lines = [{ qty: '2', unitPricePen: '50' }];
    expect(totalMismatch(lines, '118.0000')).toBeNull();
  });

  it('acepta el redondeo del papel: hasta un céntimo por línea', () => {
    // Tres líneas de 33.333333 sin IGV → el comprobante original declaró céntimos redondeados.
    const lines = [
      { qty: '1', unitPricePen: '33.3333' },
      { qty: '1', unitPricePen: '33.3333' },
      { qty: '1', unitPricePen: '33.3333' },
    ];
    expect(totalMismatch(lines, '118.0000')).toBeNull();
  });

  it('rechaza un total que no es el de sus líneas, y dice los dos números', () => {
    const lines = [{ qty: '2', unitPricePen: '50' }];
    const mismatch = totalMismatch(lines, '200.0000');
    expect(mismatch).not.toBeNull();
    expect(mismatch?.computed.toFixed(2)).toBe('118.00');
    expect(mismatch?.declared.toFixed(2)).toBe('200.00');
  });

  it('el total incluye el IGV: comparar contra el subtotal sería siempre un desvío', () => {
    const lines = [{ qty: '1', unitPricePen: '100' }];
    expect(totalMismatch(lines, '100.0000')).not.toBeNull();
    expect(totalMismatch(lines, '118.0000')).toBeNull();
  });

  it('acepta una tolerancia explícita, en vez de la de RF-71 (D-142)', () => {
    // 118 + 0.20 de desvío: la tolerancia de RF-71 (un céntimo, una sola línea) lo rechaza;
    // una tolerancia explícita de 0.25 lo acepta. Es la misma función, dos umbrales.
    const lines = [{ qty: '1', unitPricePen: '100' }];
    expect(totalMismatch(lines, '118.2000')).not.toBeNull();
    expect(totalMismatch(lines, '118.2000', new Decimal('0.25'))).toBeNull();
  });
});

describe('SALES_HISTORY_TOTAL_TOLERANCE_PEN + salesHistoryTotalMismatch (D-142)', () => {
  it('es 0.25 — el peor desvío real medido (0.21) más un margen chico', () => {
    expect(SALES_HISTORY_TOTAL_TOLERANCE_PEN).toBe('0.25');
  });

  it('acepta el peor caso real (0.21) y rechaza uno más grande (0.30)', () => {
    // Mismo caso que tumbó 18/71 documentos en producción (sesión 7-final-C): el papel
    // declara 129000.00 y las líneas sumaban 129000.08 — un desvío bien por debajo de 0.21.
    expect(salesHistoryTotalMismatch('100000.00', '18000.00', '118000.21')).toBeNull();
    expect(salesHistoryTotalMismatch('100000.00', '18000.00', '118000.30')).not.toBeNull();
  });

  it('devuelve los dos números cuando no cuadra, para el mensaje', () => {
    const mismatch = salesHistoryTotalMismatch('100.00', '18.00', '119.00');
    expect(mismatch?.computed.toFixed(2)).toBe('118.00');
    expect(mismatch?.declared.toFixed(2)).toBe('119.00');
  });

  /**
   * Canario de divergencia (pedido explícito del dueño, sesión 7-final-C): si el día de
   * mañana alguien le pone a la previsualización o a la confirmación una tolerancia propia
   * en vez de leer esta constante, este test dinámico —construido contra el valor real de
   * `SALES_HISTORY_TOTAL_TOLERANCE_PEN` y no contra un número copiado a mano— es el que
   * revienta primero.
   */
  it('el borde de la tolerancia compartida es exacto, no aproximado', () => {
    const tol = new Decimal(SALES_HISTORY_TOTAL_TOLERANCE_PEN);
    const grossJustInside = new Decimal('100').plus(tol).minus('0.01').toFixed(2);
    const grossJustOutside = new Decimal('100').plus(tol).plus('0.01').toFixed(2);
    expect(salesHistoryTotalMismatch('100.00', '0.00', grossJustInside)).toBeNull();
    expect(salesHistoryTotalMismatch('100.00', '0.00', grossJustOutside)).not.toBeNull();
  });
});
