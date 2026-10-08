import type { FiscalDocumentListItemDto } from '@ayr/shared';
import { FISCAL_DOCUMENT_LIST_COLUMNS } from './fiscal-documents-xlsx';

/** D-537 (cc33 N8): el Excel de la lista de comprobantes rotula el vencimiento como la pantalla. */
const due = FISCAL_DOCUMENT_LIST_COLUMNS.find((c) => c.header === 'Vencimiento');

function cell(over: Partial<FiscalDocumentListItemDto>): unknown {
  if (!due) throw new Error('falta la columna Vencimiento');
  return due.cell({ dueDate: null, paymentTerms: 'CONTADO', ...over } as FiscalDocumentListItemDto);
}

describe('Excel de comprobantes — vencimiento (cc33 N8)', () => {
  it('al contado dice «Contado»; a crédito sin vencimiento, «Crédito sin vencimiento»', () => {
    expect(cell({})).toBe('Contado');
    expect(cell({ paymentTerms: 'CREDITO' })).toBe('Crédito sin vencimiento');
    expect(cell({ paymentTerms: 'CREDITO', dueDate: '2026-10-30' })).toBe('2026-10-30');
  });
});
