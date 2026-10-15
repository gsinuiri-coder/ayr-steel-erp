import { creditNoteDeadline, creditNoteDeadlineWarning, effectiveDueDate } from '@ayr/shared';

/** cc54 (D-657, D-659): el plazo de las NC excepcionales y el vencimiento vigente (en `@ayr/shared`). */
describe('creditNoteDeadline (D-659)', () => {
  it('el 15.º día hábil del mes siguiente, sin sábados ni domingos', () => {
    // Octubre de 2026 empieza en jueves: 1, 2, 5..9, 12..16, 19, 20 → el 15.º es el 21.
    expect(creditNoteDeadline('2026-09-30')).toBe('2026-10-21');
    // Diciembre pasa al año siguiente: enero de 2027 empieza en viernes → el 21.
    expect(creditNoteDeadline('2026-12-15')).toBe('2027-01-21');
  });

  it('avisa solo para 02, 03 y 13, y solo fuera de plazo', () => {
    expect(
      creditNoteDeadlineWarning('CORRECCION_DESCRIPCION', '2026-09-30', '2026-10-21'),
    ).toBeNull();
    expect(
      creditNoteDeadlineWarning('CORRECCION_DESCRIPCION', '2026-09-30', '2026-10-22'),
    ).toContain('21/10/2026');
    expect(creditNoteDeadlineWarning('DESCUENTO_ITEM', '2026-01-01', '2026-10-22')).toBeNull();
  });
});

describe('effectiveDueDate (D-657)', () => {
  const nc = (over: Partial<Parameters<typeof effectiveDueDate>[1][number]>) => ({
    creditNoteReason: 'OTROS_AJUSTES',
    status: 'ACCEPTED',
    dueDate: '2026-11-30',
    issueDate: '2026-10-10',
    createdAt: '2026-10-10T10:00:00.000Z',
    ...over,
  });

  it('sin 13 vivo, el del comprobante', () => {
    expect(effectiveDueDate('2026-11-01', [])).toEqual({
      dueDate: '2026-11-01',
      changedByNote: false,
    });
    expect(effectiveDueDate('2026-11-01', [nc({ status: 'ANNULLED' })]).dueDate).toBe('2026-11-01');
    expect(
      effectiveDueDate('2026-11-01', [nc({ creditNoteReason: 'DESCUENTO_ITEM' })]).dueDate,
    ).toBe('2026-11-01');
  });

  it('el del 13 vivo más reciente (por fecha y, a igual fecha, el último registrado)', () => {
    const notes = [
      nc({ dueDate: '2026-12-15', issueDate: '2026-10-12' }),
      nc({ dueDate: '2026-12-20', issueDate: '2026-10-12', createdAt: '2026-10-12T11:00:00.000Z' }),
      nc({ dueDate: '2026-11-30', issueDate: '2026-10-10' }),
    ];
    expect(effectiveDueDate('2026-11-01', notes)).toEqual({
      dueDate: '2026-12-20',
      changedByNote: true,
    });
  });
});
