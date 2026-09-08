import { DocType, FiscalDocType } from '@prisma/client';
import { SALES_HISTORY_TOTAL_TOLERANCE_PEN } from '../fiscal-import-math';
import {
  normalizeDate,
  normalizeDecimal,
  normalizeUnit,
  parseCustomer,
  parseDocType,
  parseFulfillment,
  parsePieces,
  parseSeriesNumber,
  SalesHistoryImportAdapter,
} from './sales-history.adapter';

/**
 * D-142: el export real del dueño (`Ventas_Detalladas.xlsx`, hoja `InvoiceDetailExport`) es
 * el primer archivo real que pasó por este adaptador desde que se escribió (D-138/D-141).
 * Estas pruebas fijan, con datos tomados de ese archivo, lo que ya funcionaba (para que no
 * se rompa sin querer) y lo que no (`normalizeUnit`, que no existía).
 */

describe('normalizeDate', () => {
  it('lee una fecha de texto como DD/MM/AAAA, incluso con día ≤ 12', () => {
    // "03/08/2026" del archivo real: si el código asumiera MM/DD leería marzo, un mes
    // antes de HISTORICAL_LOAD_START (2026-08-01), y la fila se caería por fecha.
    expect(normalizeDate('03/08/2026')).toBe('2026-08-03');
    expect(normalizeDate('07/08/2026')).toBe('2026-08-07');
    expect(normalizeDate('11/08/2026')).toBe('2026-08-11');
    expect(normalizeDate('31/08/2026')).toBe('2026-08-31');
  });

  it('deja pasar una fecha ya en AAAA-MM-DD (la que entrega una celda nativa de Excel)', () => {
    expect(normalizeDate('2026-08-03')).toBe('2026-08-03');
  });
});

describe('normalizeDecimal', () => {
  it('conserva un decimal con punto tal cual lo trae el export ("81.9000000000")', () => {
    expect(normalizeDecimal('81.9000000000')).toBe('81.9000000000');
    expect(normalizeDecimal('943.932')).toBe('943.932');
  });

  it('trata la coma como separador decimal cuando es el único símbolo', () => {
    expect(normalizeDecimal('0,45')).toBe('0.45');
  });

  it('trata la coma como separador de miles cuando convive con un punto decimal', () => {
    expect(normalizeDecimal('1,234.50')).toBe('1234.50');
  });
});

describe('parseDocType', () => {
  it('reconoce los tres tipos del export real, case-insensitive', () => {
    expect(parseDocType('Factura')).toBe(FiscalDocType.FACTURA);
    expect(parseDocType('FACTURA ELECTRONICA')).toBe(FiscalDocType.FACTURA);
    expect(parseDocType('Boleta')).toBe(FiscalDocType.BOLETA);
    expect(parseDocType('boleta de venta')).toBe(FiscalDocType.BOLETA);
    expect(parseDocType('Nota Crédito')).toBe(FiscalDocType.NOTA_CREDITO);
    expect(parseDocType('NOTA DE CREDITO')).toBe(FiscalDocType.NOTA_CREDITO);
  });

  it('no adivina un tipo que no reconoce', () => {
    expect(parseDocType('Guía de remisión')).toBe(FiscalDocType.GUIA_REMISION_REMITENTE);
    expect(parseDocType('')).toBeNull();
    expect(parseDocType('algo raro')).toBeNull();
  });
});

describe('parseCustomer', () => {
  it('extrae el RUC de "RUC - NOMBRE", el formato del export real', () => {
    const result = parseCustomer('20606364335 - PROYECTOS R&B SERVICIOS GENERALES S.A.C.');
    expect(result).toEqual({
      docType: DocType.RUC,
      docNumber: '20606364335',
      name: 'PROYECTOS R&B SERVICIOS GENERALES S.A.C.',
    });
  });

  it('extrae un DNI de 8 dígitos con el mismo formato', () => {
    const result = parseCustomer('71271898 - FERNANDEZ ROSALES LEIDY CAROLINA');
    expect(result).toEqual({
      docType: DocType.DNI,
      docNumber: '71271898',
      name: 'FERNANDEZ ROSALES LEIDY CAROLINA',
    });
  });

  it('prioriza un RUC de 11 dígitos sobre un DNI si el texto trajera los dos', () => {
    const result = parseCustomer('20606364335 - Cliente 71271898');
    expect(result?.docType).toBe(DocType.RUC);
    expect(result?.docNumber).toBe('20606364335');
  });

  it('no identifica un cliente sin RUC ni DNI', () => {
    expect(parseCustomer('CLIENTE SIN DOCUMENTO')).toBeUndefined();
  });
});

describe('parseSeriesNumber', () => {
  it('lee "SERIE - NÚMERO" del export real', () => {
    expect(parseSeriesNumber('FFC1-73')).toEqual({ series: 'FFC1', correlative: 73 });
    expect(parseSeriesNumber('F001-00000123')).toEqual({ series: 'F001', correlative: 123 });
  });

  it('no adivina un formato que no reconoce', () => {
    expect(parseSeriesNumber('sin serie')).toBeUndefined();
  });
});

describe('normalizeUnit (D-142)', () => {
  it('mapea las cuatro unidades del export real a su código de catálogo', () => {
    expect(normalizeUnit('METRO LINEAL')).toBe('MTR');
    expect(normalizeUnit('KILOGRAMO')).toBe('KGM');
    expect(normalizeUnit('UNIDAD')).toBe('NIU');
    expect(normalizeUnit('TONELADA')).toBe('TNE');
  });

  it('es insensible a mayúsculas y a espacios sobrantes', () => {
    expect(normalizeUnit('  metro lineal  ')).toBe('MTR');
  });

  it('deja pasar una unidad que no reconoce, mayúscula y recortada', () => {
    expect(normalizeUnit('galón')).toBe('GALÓN');
  });
});

describe('parseFulfillment', () => {
  it('acepta PENDING y su forma en español', () => {
    expect(parseFulfillment('PENDING')).toBe('PENDING');
    expect(parseFulfillment('pendiente')).toBe('PENDING');
  });

  it('todo lo demás, incluida una celda vacía, es DELIVERED (el default conservador)', () => {
    expect(parseFulfillment('')).toBe('DELIVERED');
    expect(parseFulfillment('entregado')).toBe('DELIVERED');
    expect(parseFulfillment('algo raro')).toBe('DELIVERED');
  });
});

describe('parsePieces', () => {
  it('lee "largo x cantidad" en metros, separados por coma', () => {
    const pieces = parsePieces('3.60x4, 5.00x2');
    expect(pieces).toEqual([
      { lineNumber: 1, lengthMm: '3600.00', qty: 4 },
      { lineNumber: 2, lengthMm: '5000.00', qty: 2 },
    ]);
  });

  it('no adivina un formato que no reconoce', () => {
    expect(parsePieces('tres metros')).toBeUndefined();
  });
});

describe('validateGroup — el cuadre del documento usa la tolerancia compartida (D-142)', () => {
  // `prisma` es la única dependencia que `validateGroup` toca, y solo si el grupo trae
  // `series`/`correlative` (para el chequeo de reimportación) — estas filas no los traen,
  // así que ese chequeo se salta y el mock nunca se llama. El resto de las dependencias del
  // adaptador no participan de este camino.
  const adapter = new SalesHistoryImportAdapter(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  /** Dos líneas cuya suma de neto/IGV declarada difiere del precio de venta en `diffPen`. */
  function rowsWithDiff(diffPen: string): { data: Record<string, unknown>; errors: string[] }[] {
    const shared = {
      issueDate: '2026-08-03',
      docType: FiscalDocType.FACTURA,
      customerDocNumber: '20606364335',
    };
    return [
      {
        data: { ...shared, netPen: '100000.00', igvPen: '18000.00', grossPen: '118000.00' },
        errors: [],
      },
      { data: { ...shared, netPen: '0.00', igvPen: '0.00', grossPen: diffPen }, errors: [] },
    ];
  }

  it('acepta el peor desvío real medido (0.21) sin avisar', async () => {
    const issues = await adapter.validateGroup(rowsWithDiff('0.21'));
    expect(issues.every((i) => i.warnings.length === 0)).toBe(true);
  });

  it('avisa "no cuadra" por encima de la tolerancia compartida — el mismo umbral que rechazaría al confirmar', async () => {
    const tolerance = Number(SALES_HISTORY_TOTAL_TOLERANCE_PEN);
    const issues = await adapter.validateGroup(rowsWithDiff((tolerance + 0.05).toFixed(2)));
    expect(issues.every((i) => i.warnings.some((w) => w.includes('no cuadra')))).toBe(true);
  });
});
