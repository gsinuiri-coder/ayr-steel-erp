import {
  createPurchaseSchema,
  documentNumberSchema,
  splitDocumentNumber,
  type CreatePurchaseInput,
} from '@ayr/shared';

/**
 * cc33 — los bordes del alta de compra en `@ayr/shared` (el paquete no tiene tests propios).
 */
const BASE: CreatePurchaseInput = {
  supplierId: '00000000-0000-4000-8000-000000000001',
  businessLine: 'metallic-roofing',
  type: 'FINISHED_GOOD',
  docType: 'FACTURA',
  series: 'F001',
  number: '12',
  issueDate: '2026-09-20',
  currency: 'PEN',
  igvRate: '18.0000',
  paymentTerms: 'CONTADO',
  items: [
    {
      productId: '00000000-0000-4000-8000-000000000002',
      description: 'Tornillo',
      qty: '10',
      unit: 'NIU',
      unitPrice: '1.0000',
    },
  ],
};

function issuesOf(input: Record<string, unknown>): string[] {
  const res = createPurchaseSchema.safeParse(input);
  return res.success ? [] : res.error.issues.map((i) => i.path.join('.'));
}

describe('createPurchaseSchema — TC en soles (cc33 N1)', () => {
  it('rechaza una compra en soles con TC distinto de 1', () => {
    expect(issuesOf({ ...BASE, exchangeRate: '3.75' })).toContain('exchangeRate');
    expect(issuesOf({ ...BASE, exchangeRate: '0.9999' })).toContain('exchangeRate');
  });

  it('acepta soles con TC 1 o sin TC, y dólares con cualquier TC', () => {
    expect(issuesOf({ ...BASE, exchangeRate: '1' })).toEqual([]);
    expect(issuesOf({ ...BASE, exchangeRate: '1.0000' })).toEqual([]);
    expect(issuesOf({ ...BASE })).toEqual([]);
    expect(issuesOf({ ...BASE, currency: 'USD', exchangeRate: '3.75' })).toEqual([]);
  });
});

describe('createPurchaseSchema — fecha de emisión (cc33 N5)', () => {
  it.each([['2026-02-31'], ['2026-09-31'], ['2026-08-32']])('%s se rechaza', (issueDate) => {
    expect(issuesOf({ ...BASE, issueDate })).toContain('issueDate');
  });

  it('una fecha que existe pasa', () => {
    expect(issuesOf({ ...BASE, issueDate: '2026-02-28' })).toEqual([]);
  });
});

describe('documentNumberSchema — número de compra (cc33 B8 y ceros)', () => {
  it('acepta letras, dígitos, guion y barra, en mayúsculas', () => {
    expect(documentNumberSchema.parse(' a-12/3 ')).toBe('A-12/3');
  });

  it.each([[''], ['123456789012345678901'], ['12.5'], ['12 3']])('«%s» se rechaza', (number) => {
    expect(documentNumberSchema.safeParse(number).success).toBe(false);
  });

  it('se guarda sin ceros a la izquierda', () => {
    expect(documentNumberSchema.parse('00012')).toBe('12');
    expect(documentNumberSchema.parse('000')).toBe('0');
    expect(documentNumberSchema.parse('0-12')).toBe('0-12');
  });
});

describe('splitDocumentNumber (cc33 B8)', () => {
  it('separa en el primer guion y acepta el número alfanumérico', () => {
    expect(splitDocumentNumber('f001-a-12')).toEqual({ series: 'F001', number: 'A-12' });
    expect(splitDocumentNumber('F001-00012345')).toEqual({ series: 'F001', number: '00012345' });
  });

  it('un número fuera del formato no se lee', () => {
    expect(splitDocumentNumber('F001-12.5')).toBeNull();
    expect(splitDocumentNumber('F001-')).toBeNull();
  });
});
