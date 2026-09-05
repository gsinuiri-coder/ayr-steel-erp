import * as XLSX from 'xlsx';
import { parseSpreadsheet } from './parse-spreadsheet';
import { getField, rawToString } from './adapters/import-adapter.interface';

/**
 * Lectura de planillas (RF-52). Las dos cosas que ya rompieron una importación entera en
 * silencio y por eso tienen prueba: el **codepage** de un csv con tildes (Fase 1) y las
 * **fechas**, que SheetJS entrega como número de serie de Excel si no se le pide lo
 * contrario (RF-71 — antes de esta fase ninguna entidad importable tenía columna de fecha).
 */

function xlsxBuffer(rows: Record<string, unknown>[]): Buffer {
  const sheet = XLSX.utils.json_to_sheet(rows, { cellDates: true });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Hoja1');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx', cellDates: true }) as Buffer;
}

const DATE_COLUMN = { key: 'issueDate', header: 'Fecha de emisión', required: true };

describe('parseSpreadsheet', () => {
  it('respeta los encabezados con tilde de un csv (UTF-8, no el codepage por defecto)', () => {
    const csv = 'Línea,Descripción\ndrywall,Perfil\n';
    const rows = parseSpreadsheet(Buffer.from(csv, 'utf8'));
    expect(rows[0]?.['Línea']).toBe('drywall');
    expect(rows[0]?.['Descripción']).toBe('Perfil');
  });

  it('devuelve una fecha de csv como fecha, no como el número de serie de Excel', () => {
    // Sin `cellDates`, `2026-09-05` llegaba como `46270` y toda fila con fecha quedaba
    // inválida por formato: ninguna planilla de comprobantes se podía importar.
    const csv = 'Fecha de emisión,Serie\n2026-09-05,F001\n';
    const rows = parseSpreadsheet(Buffer.from(csv, 'utf8'));
    expect(getField(rows[0] ?? {}, DATE_COLUMN)).toBe('2026-09-05');
  });

  it('devuelve una fecha de xlsx como fecha', () => {
    const buffer = xlsxBuffer([{ 'Fecha de emisión': new Date(2026, 8, 5), Serie: 'F001' }]);
    const rows = parseSpreadsheet(buffer);
    expect(getField(rows[0] ?? {}, DATE_COLUMN)).toBe('2026-09-05');
  });

  it('no corre el día de una fecha: la celda es un día calendario, no un instante', () => {
    // `toISOString` habría restado un día al este de Greenwich. La fecha se formatea con
    // las partes locales, que es como SheetJS la construye.
    const rows = parseSpreadsheet(Buffer.from('Fecha de emisión\n2026-01-01\n', 'utf8'));
    expect(getField(rows[0] ?? {}, DATE_COLUMN)).toBe('2026-01-01');
  });

  it('rechaza un archivo sin filas de datos', () => {
    expect(() => parseSpreadsheet(Buffer.from('Serie\n', 'utf8'))).toThrow();
  });
});

describe('rawToString', () => {
  it('formatea una fecha como día calendario en AAAA-MM-DD', () => {
    expect(rawToString(new Date(2026, 8, 5, 23, 30))).toBe('2026-09-05');
    expect(rawToString(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });
});
