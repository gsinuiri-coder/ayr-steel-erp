import { describe, expect, it } from 'vitest';
import { CREDIT_NOTE_KINDS, CREDIT_NOTE_REASONS } from '@ayr/shared';
import { creditNoteDateError, creditNoteKindOf, defaultReasonOfKind } from './credit-note-form';

describe('grupos del motivo de una NC (D-646)', () => {
  it('cada motivo SUNAT cae en un grupo y vuelve al mismo desde su motivo por defecto', () => {
    for (const reason of CREDIT_NOTE_REASONS) {
      expect(CREDIT_NOTE_KINDS).toContain(creditNoteKindOf(reason));
    }
    for (const kind of CREDIT_NOTE_KINDS) {
      expect(creditNoteKindOf(defaultReasonOfKind(kind))).toBe(kind);
    }
  });

  it('las devoluciones son el grupo RETURN', () => {
    expect(creditNoteKindOf('DEVOLUCION_TOTAL')).toBe('RETURN');
    expect(creditNoteKindOf('DEVOLUCION_ITEM')).toBe('RETURN');
    expect(creditNoteKindOf('DESCUENTO_ITEM')).toBe('DISCOUNT');
    expect(creditNoteKindOf('ANULACION_OPERACION')).toBe('ANNUL');
  });
});

describe('creditNoteDateError (D-645)', () => {
  const today = '2026-10-14';

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
