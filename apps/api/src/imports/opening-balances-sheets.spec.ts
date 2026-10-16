import * as XLSX from 'xlsx';
import {
  customerTemplate,
  readOpeningRows,
  supplierKey,
  supplierTemplate,
} from './opening-balances-sheets';

function sheetOf(buffer: Buffer, name: string): unknown[][] {
  const book = XLSX.read(buffer, { type: 'buffer' });
  const sheet = book.Sheets[name];
  if (!sheet) throw new Error(`sin hoja ${name}`);
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
}

function bookOf(rows: (string | number)[][]): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Hoja');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('plantillas de saldos iniciales', () => {
  it('la vacía de cobranzas trae el ejemplo ficticio y se vuelve a leer igual', () => {
    const buffer = customerTemplate(null, '2026-09-30');
    const rows = readOpeningRows(buffer, 'CUSTOMERS');
    expect(rows.map((r) => [r.rowNumber, r.key, r.date, r.amount, r.method, r.balance])).toEqual([
      [2, 'F001-00000001', '2026-08-20', '500', 'Transferencia', ''],
      [3, 'F001-00000001', '2026-09-05', '300', 'Depósito', ''],
      [4, 'F001-00000002', '', '', '', '1000'],
    ]);
    expect(sheetOf(buffer, 'Instrucciones').flat().join(' ')).toMatch(/pagado al corte/);
  });

  it('la prellenada de cobranzas trae los comprobantes con lo de referencia y lo demás vacío', () => {
    const buffer = customerTemplate(
      [
        {
          number: 'FFA1-00000010',
          customer: 'ACME',
          customerDoc: '20111111111',
          issueDate: '2026-08-01',
          dueDate: null,
          totalPen: '100.00',
          balancePen: '100.00',
        },
      ],
      '2026-09-30',
    );
    const [headers, first] = sheetOf(buffer, 'Cobranzas');
    expect(headers).toContain('Saldo pendiente al corte S/');
    expect(first?.slice(0, 7)).toEqual([
      'FFA1-00000010',
      'ACME',
      '20111111111',
      '2026-08-01',
      '',
      100,
      100,
    ]);
    expect(readOpeningRows(buffer, 'CUSTOMERS')[0]).toMatchObject({
      key: 'FFA1-00000010',
      amount: '',
      balance: '',
    });
  });

  it('la de pagos arma la clave con RUC y compra, y lee el tipo de cambio', () => {
    const blank = readOpeningRows(supplierTemplate(null, '2026-09-30'), 'SUPPLIERS');
    expect(blank.map((r) => [r.key, r.amount, r.exchangeRate, r.balance])).toEqual([
      ['20000000009 · F001-000123', '5900', '', ''],
      ['20000000009 · F001-000124', '1000', '3.75', ''],
      ['20000000008 · E001-55', '', '', '200'],
    ]);
    const filled = supplierTemplate(
      [
        {
          supplierDoc: '20999999999',
          supplier: 'PROV',
          document: 'F1-9',
          issueDate: '2026-08-01',
          currency: 'USD',
          total: '10.00',
          balance: '10.00',
        },
      ],
      '2026-09-30',
    );
    expect(readOpeningRows(filled, 'SUPPLIERS')[0]?.key).toBe('20999999999 · F1-9');
  });

  it('lee encabezados sin tildes ni mayúsculas, y la compra en minúsculas', () => {
    const rows = readOpeningRows(
      bookOf([
        ['ruc proveedor', 'compra', 'monto pagado', 'saldo pendiente al corte'],
        ['20999999999', 'f001-9', 10, ''],
        ['', '', '', ''],
      ]),
      'SUPPLIERS',
    );
    expect(rows[0]?.key).toBe(supplierKey('20999999999', 'F001-9'));
    expect(rows[1]?.key).toBe('');
  });

  it('el comprobante se lee en mayúsculas', () => {
    const rows = readOpeningRows(
      bookOf([
        ['Comprobante', 'Saldo pendiente al corte S/'],
        ['ffa1-00000010', 0],
      ]),
      'CUSTOMERS',
    );
    expect(rows[0]).toMatchObject({ key: 'FFA1-00000010', balance: '0' });
  });
});
