import { createPurchaseSchema, type CreatePurchaseInput } from '@ayr/shared';

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
  });

  it('acepta soles con TC 1 o sin TC, y dólares con cualquier TC', () => {
    expect(issuesOf({ ...BASE, exchangeRate: '1' })).toEqual([]);
    expect(issuesOf({ ...BASE })).toEqual([]);
    expect(issuesOf({ ...BASE, currency: 'USD', exchangeRate: '3.75' })).toEqual([]);
  });
});
