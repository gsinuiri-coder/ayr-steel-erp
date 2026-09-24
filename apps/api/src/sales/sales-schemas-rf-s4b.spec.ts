import { createQuotationSchema, updateSalesOrderItemPriceSchema } from '@ayr/shared';

/**
 * D-255 en el borde (Zod): una línea se carga con **una** forma de importe, y el IGV y el total
 * del papel viajan juntos y con el importe. El API lo valida al entrar; hasta acá solo lo
 * cubría el E2E (repaso de RF-S4b, cobertura del gate de Sonar).
 */
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const quotation = (item: Record<string, unknown>) => ({
  customerId: '11111111-1111-4111-8111-111111111111',
  issueDate: '2026-09-24',
  validityDays: 7,
  items: [{ productId: PRODUCT, qty: '10.000', ...item }],
});
const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : (r.error?.issues.map((i) => i.message) ?? []);

describe('D-255 — formas del importe en el schema de líneas', () => {
  it('una sola forma pasa', () => {
    expect(
      createQuotationSchema.safeParse(quotation({ unitPriceWithIgvPen: '4.7200' })).success,
    ).toBe(true);
    expect(createQuotationSchema.safeParse(quotation({ netAmountPen: '40.0000' })).success).toBe(
      true,
    );
  });

  it('dos formas a la vez se rechazan', () => {
    const r = createQuotationSchema.safeParse(
      quotation({ unitPricePen: '4.0000', unitPriceWithIgvPen: '4.7200' }),
    );
    expect(messages(r)).toContain(
      'Carga el precio con IGV, el valor unitario o el importe de la línea: una sola de las tres',
    );
  });

  it('el IGV y el total del papel viajan juntos y con el importe', () => {
    const sinTotal = createQuotationSchema.safeParse(
      quotation({ netAmountPen: '40.0000', igvAmountPen: '7.2000' }),
    );
    expect(messages(sinTotal)).toContain(
      'El IGV y el total del papel viajan juntos y con el importe de la línea',
    );
    const trio = createQuotationSchema.safeParse(
      quotation({ netAmountPen: '40.0000', igvAmountPen: '7.2000', totalAmountPen: '47.2000' }),
    );
    expect(trio.success).toBe(true);
  });
});

describe('D-255 — cambio de precio de una línea de pedido', () => {
  it('exige exactamente una forma del precio', () => {
    expect(updateSalesOrderItemPriceSchema.safeParse({ netAmountPen: '40.0000' }).success).toBe(
      true,
    );
    expect(updateSalesOrderItemPriceSchema.safeParse({}).success).toBe(false);
    expect(
      updateSalesOrderItemPriceSchema.safeParse({
        unitPricePen: '4.0000',
        unitPriceWithIgvPen: '4.7200',
      }).success,
    ).toBe(false);
  });
});
