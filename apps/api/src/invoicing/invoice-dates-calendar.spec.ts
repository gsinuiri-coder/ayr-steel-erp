import {
  createCustomerPaymentSchema,
  createDispatchSchema,
  updateManualIssueDateSchema,
} from '@ayr/shared';

/**
 * cc65 (pendiente de cc61): una fecha que no existe en el calendario se rechaza en **todos** los
 * campos de fecha de comprobantes, no solo en el vencimiento. `Date.parse('2026-02-31')` la rodaba
 * al 3 de marzo y entraba.
 */
const message = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? null : (r.error?.issues.map((i) => i.message) ?? []);

describe('cc65: fechas imposibles en comprobantes', () => {
  it.each(['2026-02-31', '2026-04-31', '2026-13-01', '2026-02-29'])(
    'la emisión %s se rechaza',
    (issueDate) => {
      const r = updateManualIssueDateSchema.safeParse({ issueDate });
      expect(message(r)).toContain('Esa fecha no existe en el calendario');
    },
  );

  it('una fecha real sigue entrando (también el 29 de febrero bisiesto)', () => {
    // El 29/02/2024 existe: si se rechaza, no es por el calendario (puede serlo por la ventana).
    const leap = updateManualIssueDateSchema.safeParse({ issueDate: '2024-02-29' });
    expect(message(leap) ?? []).not.toContain('Esa fecha no existe en el calendario');
    const today = updateManualIssueDateSchema.safeParse({ issueDate: '2026-10-21' });
    expect(message(today) ?? []).not.toContain('Esa fecha no existe en el calendario');
  });

  it('el cobro y el despacho también la rechazan', () => {
    const pay = createCustomerPaymentSchema.safeParse({
      date: '2026-02-30',
      amountPen: '10.00',
      method: 'CASH',
    });
    expect(message(pay)).toContain('Esa fecha no existe en el calendario');
    const dispatch = createDispatchSchema.safeParse({ dispatchDate: '2026-06-31' });
    expect(message(dispatch)).toContain('Esa fecha no existe en el calendario');
  });
});
