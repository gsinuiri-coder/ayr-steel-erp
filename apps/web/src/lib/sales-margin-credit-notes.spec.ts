import { describe, expect, it } from 'vitest';
import type { SalesMarginCreditNoteDto } from '@ayr/shared';
import {
  creditNoteReasonText,
  creditNotesLinkLabel,
  filterCreditNotes,
} from './sales-margin-credit-notes';

function note(over: Partial<SalesMarginCreditNoteDto>): SalesMarginCreditNoteDto {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    number: 'BC90-00000001',
    issueDate: '2026-10-05',
    reason: 'DEVOLUCION_ITEM',
    affectedDocumentId: '22222222-2222-2222-2222-222222222222',
    affectedNumber: 'B900-00000001',
    affectedIssueDate: '2026-09-20',
    affectedEarlierMonth: true,
    salesOrderId: null,
    orderCode: 'PED-000010',
    customerId: '33333333-3333-3333-3333-333333333333',
    customerName: 'Ferretería Norte',
    customerDocNumber: '20100000001',
    salesPen: '-6.6000',
    costPen: '-4.9682',
    marginPen: '-1.6318',
    inTotals: true,
    ...over,
  };
}

describe('notas de crédito de Ventas y margen (cc67, D-720)', () => {
  const notes = [
    note({}),
    note({
      id: '44444444-4444-4444-4444-444444444444',
      number: 'BC90-00000002',
      reason: 'DESCUENTO_GLOBAL',
      affectedNumber: 'F900-00000009',
      customerName: 'Constructora Sur',
      customerDocNumber: '20200000002',
      orderCode: null,
    }),
  ];

  it('busca por NC, comprobante afectado, pedido, cliente, RUC y motivo, sin cambiar el orden', () => {
    expect(filterCreditNotes(notes, '').map((n) => n.number)).toEqual([
      'BC90-00000001',
      'BC90-00000002',
    ]);
    expect(filterCreditNotes(notes, 'F900-00000009').map((n) => n.number)).toEqual([
      'BC90-00000002',
    ]);
    expect(filterCreditNotes(notes, 'ped-000010').map((n) => n.number)).toEqual(['BC90-00000001']);
    expect(filterCreditNotes(notes, '20200000002').map((n) => n.number)).toEqual(['BC90-00000002']);
    expect(filterCreditNotes(notes, 'devolucion').map((n) => n.number)).toEqual(['BC90-00000001']);
    expect(filterCreditNotes(notes, 'sur 04').map((n) => n.number)).toEqual(['BC90-00000002']);
  });

  it('el motivo lleva su código SUNAT visible', () => {
    expect(creditNoteReasonText('DEVOLUCION_ITEM')).toBe('07 · Devolución por ítem');
    expect(creditNoteReasonText('CORRECCION_DESCRIPCION')).toBe(
      '03 · Corrección por error en la descripción',
    );
    expect(creditNoteReasonText(null)).toBe('—');
  });

  it('el enlace dice cuántas NC hay', () => {
    expect(creditNotesLinkLabel(1)).toBe('Ver la nota de crédito');
    expect(creditNotesLinkLabel(12)).toBe('Ver las 12 notas de crédito');
  });
});
