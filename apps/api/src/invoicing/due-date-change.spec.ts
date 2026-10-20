import {
  dueDateChangeBlock,
  dueDateViolations,
  type DueDateChangeDocument,
} from './due-date-change';

/** cc61 (D-699): las reglas del vencimiento editable desde el detalle. */
const base: DueDateChangeDocument = {
  docType: 'FACTURA',
  status: 'ACCEPTED',
  paymentTerms: 'CREDITO',
  archivedAt: null,
  issueDate: '2026-09-11',
  dueDate: null,
  creditNotes: [],
};
const note13 = (over: Partial<DueDateChangeDocument['creditNotes'][number]> = {}) => ({
  number: 'FC01-00000001',
  creditNoteReason: 'OTROS_AJUSTES',
  status: 'ACCEPTED',
  dueDate: '2026-10-20',
  issueDate: '2026-09-20',
  createdAt: '2026-09-20T15:00:00.000Z',
  ...over,
});

describe('dueDateChangeBlock (cc61, D-699)', () => {
  it('una factura al crédito sin vencimiento lo recibe', () => {
    expect(dueDateChangeBlock(base, '2026-10-11')).toBeNull();
  });

  it('el mismo día de la emisión vale; antes, no', () => {
    expect(dueDateChangeBlock(base, '2026-09-11')).toBeNull();
    expect(dueDateChangeBlock(base, '2026-09-10')).toContain('anterior a la emisión (2026-09-11)');
  });

  it('el mismo vencimiento que ya tiene se rechaza', () => {
    expect(dueDateChangeBlock({ ...base, dueDate: '2026-10-11' }, '2026-10-11')).toContain(
      'ya es 2026-10-11',
    );
  });

  it('al contado, anulado, archivado, en borrador o una nota: no', () => {
    expect(dueDateChangeBlock({ ...base, paymentTerms: 'CONTADO' }, '2026-10-11')).toContain(
      'al crédito',
    );
    expect(dueDateChangeBlock({ ...base, status: 'ANNULLED' }, '2026-10-11')).toContain('vigente');
    expect(dueDateChangeBlock({ ...base, status: 'DRAFT' }, '2026-10-11')).toContain('vigente');
    expect(dueDateChangeBlock({ ...base, archivedAt: new Date() }, '2026-10-11')).toContain(
      'vigente',
    );
    expect(dueDateChangeBlock({ ...base, docType: 'NOTA_CREDITO' }, '2026-10-11')).toContain(
      'factura o una boleta',
    );
  });

  it('una boleta al crédito también', () => {
    expect(dueDateChangeBlock({ ...base, docType: 'BOLETA' }, '2026-10-11')).toBeNull();
  });

  it('con una NC 13 viva se rechaza nombrándola; anulada, no cuenta', () => {
    expect(dueDateChangeBlock({ ...base, creditNotes: [note13()] }, '2026-10-11')).toBe(
      'Este comprobante tiene una NC 13 vigente (FC01-00000001) que fija su vencimiento: anúlala o registra otra',
    );
    expect(
      dueDateChangeBlock({ ...base, creditNotes: [note13({ status: 'ANNULLED' })] }, '2026-10-11'),
    ).toBeNull();
    // Otra nota viva (no 13) no fija el vencimiento.
    expect(
      dueDateChangeBlock(
        { ...base, creditNotes: [note13({ creditNoteReason: 'DESCUENTO_GLOBAL' })] },
        '2026-10-11',
      ),
    ).toBeNull();
  });
});

describe('dueDateViolations (cc61, CLI de vencimiento)', () => {
  const ok = {
    documentId: 'x',
    status: 'ACCEPTED',
    paymentTerms: 'CREDITO',
    issueDate: '2026-09-11',
    dueDateBefore: null,
    dueDateAfter: '2026-10-11',
    changedFields: ['dueDate', 'updatedAt'],
    newAuditActions: ['invoicing.document.update-due-date'],
    otherDocsTouched: 0,
    rejected: null,
  };

  it('solo el vencimiento y su auditoría: cumple', () => {
    expect(dueDateViolations(ok, '2026-10-11')).toEqual([]);
  });

  it('un rechazo del servicio (NC 13 viva, emisión posterior) no cumple', () => {
    const v = dueDateViolations(
      {
        ...ok,
        issueDate: '2026-10-12',
        dueDateAfter: null,
        changedFields: [],
        newAuditActions: [],
        rejected: 'Este comprobante tiene una NC 13 vigente',
      },
      '2026-10-11',
    );
    expect(v).toHaveLength(2);
    expect(v[0]).toContain('NC 13');
    expect(v[1]).toContain('posterior');
  });

  it('otra columna, otra auditoría u otro comprobante tocado: no cumple', () => {
    expect(
      dueDateViolations({ ...ok, changedFields: ['dueDate', 'totalPen'] }, '2026-10-11'),
    ).toEqual(['cambian otras columnas: totalPen']);
    expect(
      dueDateViolations(
        { ...ok, newAuditActions: ['invoicing.document.update-due-date', 'otra'] },
        '2026-10-11',
      ),
    ).toHaveLength(1);
    expect(dueDateViolations({ ...ok, newAuditActions: [] }, '2026-10-11')[0]).toContain('ninguna');
    expect(dueDateViolations({ ...ok, otherDocsTouched: 2 }, '2026-10-11')).toEqual([
      'se tocaron 2 comprobantes más',
    ]);
    expect(dueDateViolations({ ...ok, dueDateAfter: '2026-10-12' }, '2026-10-11')[0]).toContain(
      'quedó en 2026-10-12',
    );
  });
});
