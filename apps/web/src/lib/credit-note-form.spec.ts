import { describe, expect, it } from 'vitest';
import { CREDIT_NOTE_GROUPS, CREDIT_NOTE_REASONS } from '@ayr/shared';
import {
  creditNoteBody,
  creditNoteDateError,
  creditNoteGroupOfReason,
  defaultReasonOfGroup,
  emptyCreditNoteDraft,
  paperNumberError,
} from './credit-note-form';

const today = '2026-10-14';

describe('tarjetas del motivo de una NC (cc54, D-663)', () => {
  it('cada motivo SUNAT cae en una tarjeta y vuelve a ella desde su motivo por defecto', () => {
    for (const reason of CREDIT_NOTE_REASONS) {
      expect(CREDIT_NOTE_GROUPS).toContain(creditNoteGroupOfReason(reason));
    }
    for (const group of CREDIT_NOTE_GROUPS) {
      expect(creditNoteGroupOfReason(defaultReasonOfGroup(group))).toBe(group);
    }
  });

  it('el motivo decide la tarjeta', () => {
    expect(creditNoteGroupOfReason('DEVOLUCION_ITEM')).toBe('DEVOLVER');
    expect(creditNoteGroupOfReason('DESCUENTO_GLOBAL')).toBe('REBAJAR');
    expect(creditNoteGroupOfReason('CORRECCION_DESCRIPCION')).toBe('CORREGIR');
    expect(creditNoteGroupOfReason('OTROS_AJUSTES')).toBe('CUOTAS');
    expect(creditNoteGroupOfReason('ANULACION_ERROR_RUC')).toBe('ANULAR');
  });
});

describe('creditNoteBody: lo que se manda por motivo', () => {
  const draft = (reason: Parameters<typeof emptyCreditNoteDraft>[0]) =>
    emptyCreditNoteDraft(reason, today);

  it('01 y 06 no llevan más datos', () => {
    expect(creditNoteBody(draft('ANULACION_OPERACION'))).toEqual({
      body: { reason: 'ANULACION_OPERACION', issueDate: today },
    });
    expect(creditNoteBody({ ...draft('DEVOLUCION_TOTAL'), notes: ' nota ' })).toEqual({
      body: { reason: 'DEVOLUCION_TOTAL', issueDate: today, notes: 'nota' },
    });
  });

  it('07 manda solo las cantidades escritas y rechaza las inválidas', () => {
    expect(creditNoteBody(draft('DEVOLUCION_ITEM'))).toEqual({
      error: 'Escribe la cantidad devuelta de al menos una línea',
    });
    expect(creditNoteBody({ ...draft('DEVOLUCION_ITEM'), qty: { a: '2', b: ' ' } })).toEqual({
      body: {
        reason: 'DEVOLUCION_ITEM',
        issueDate: today,
        items: [{ affectedItemId: 'a', qty: '2' }],
      },
    });
    expect(creditNoteBody({ ...draft('DEVOLUCION_ITEM'), qty: { a: '-1' } })).toHaveProperty(
      'error',
    );
  });

  it('05 manda el precio nuevo con IGV; 04, el monto al céntimo', () => {
    expect(creditNoteBody({ ...draft('DESCUENTO_ITEM'), price: { a: '66.08' } })).toEqual({
      body: {
        reason: 'DESCUENTO_ITEM',
        issueDate: today,
        prices: [{ affectedItemId: 'a', unitPriceWithIgvPen: '66.08' }],
      },
    });
    expect(creditNoteBody({ ...draft('DESCUENTO_ITEM'), price: { a: 'x' } })).toHaveProperty(
      'error',
    );
    expect(creditNoteBody(draft('DESCUENTO_ITEM'))).toHaveProperty('error');
    expect(creditNoteBody({ ...draft('DESCUENTO_GLOBAL'), amount: '59.00' })).toEqual({
      body: { reason: 'DESCUENTO_GLOBAL', issueDate: today, amountPen: '59.00' },
    });
    expect(creditNoteBody({ ...draft('DESCUENTO_GLOBAL'), amount: '1.005' })).toEqual({
      error: 'El monto va con hasta dos decimales (céntimos)',
    });
    expect(creditNoteBody(draft('DESCUENTO_GLOBAL'))).toHaveProperty('error');
  });

  it('03 manda las descripciones corregidas; 13, el vencimiento', () => {
    expect(
      creditNoteBody({ ...draft('CORRECCION_DESCRIPCION'), description: { a: ' Nueva ' } }),
    ).toEqual({
      body: {
        reason: 'CORRECCION_DESCRIPCION',
        issueDate: today,
        descriptions: [{ affectedItemId: 'a', description: 'Nueva' }],
      },
    });
    expect(creditNoteBody(draft('CORRECCION_DESCRIPCION'))).toHaveProperty('error');
    expect(creditNoteBody({ ...draft('OTROS_AJUSTES'), dueDate: '2026-11-30' })).toEqual({
      body: { reason: 'OTROS_AJUSTES', issueDate: today, dueDate: '2026-11-30' },
    });
    expect(creditNoteBody(draft('OTROS_AJUSTES'))).toHaveProperty('error');
  });

  it('02 exige el reemplazo completo', () => {
    const base = draft('ANULACION_ERROR_RUC');
    expect(creditNoteBody(base)).toEqual({ error: 'Elige el cliente correcto' });
    const r = { customerId: 'c', issueDate: today, series: 'f001', correlative: '45' };
    expect(creditNoteBody({ ...base, replacement: r })).toEqual({
      body: {
        reason: 'ANULACION_ERROR_RUC',
        issueDate: today,
        replacement: { customerId: 'c', issueDate: today, series: 'F001', correlative: 45 },
      },
    });
    expect(creditNoteBody({ ...base, replacement: { ...r, series: 'F1' } })).toHaveProperty(
      'error',
    );
    expect(creditNoteBody({ ...base, replacement: { ...r, correlative: '0' } })).toHaveProperty(
      'error',
    );
    expect(creditNoteBody({ ...base, replacement: { ...r, issueDate: '' } })).toHaveProperty(
      'error',
    );
  });

  it('paperNumberError valida la serie y el número del papel', () => {
    expect(paperNumberError('fc01', '45')).toBeNull();
    expect(paperNumberError('F1', '45')).toMatch(/serie/);
    expect(paperNumberError('FC01', '')).toMatch(/número/);
  });
});

describe('creditNoteDateError (D-645)', () => {
  it('hoy vale para cualquier rol', () => {
    expect(creditNoteDateError(today, '2026-10-01', today, false)).toBeNull();
    expect(creditNoteDateError(today, '2026-10-01', today, true)).toBeNull();
  });

  it('el administrador puede atrasarla hasta la emisión del comprobante', () => {
    expect(creditNoteDateError('2026-10-01', '2026-10-01', today, true)).toBeNull();
    expect(creditNoteDateError('2026-09-30', '2026-10-01', today, true)).toMatch(/anterior/);
  });

  it('otro rol no elige otra fecha que hoy', () => {
    expect(creditNoteDateError('2026-10-05', '2026-10-01', today, false)).toMatch(/administrador/);
  });

  it('no después de hoy ni fuera de la ventana de emisión', () => {
    expect(creditNoteDateError('2026-10-15', '2026-10-01', today, true)).toMatch(/posterior/);
    expect(creditNoteDateError('2026-06-01', '2026-01-01', today, true)).toMatch(/días/);
    expect(creditNoteDateError('', '2026-10-01', today, true)).toMatch(/válida/);
  });
});
