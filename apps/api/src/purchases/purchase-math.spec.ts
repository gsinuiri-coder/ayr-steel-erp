import { Currency } from '@prisma/client';
import { Decimal, type CreatePurchaseInput } from '@ayr/shared';
import {
  computeDueDate,
  computeTotals,
  paidAmount,
  purchaseBalance,
  toPurchaseCurrency,
  type BalanceablePayment,
} from './purchase-math';

/**
 * Los `Decimal` de Prisma son `decimal.js` por debajo y el módulo solo los lee con
 * `toString()`, así que uno de `@ayr/shared` sirve igual en los tests.
 */
const dec = (value: string) => new Decimal(value);

function purchaseInput(overrides: Partial<CreatePurchaseInput> = {}): CreatePurchaseInput {
  const base: CreatePurchaseInput = {
    supplierId: '11111111-1111-4111-8111-111111111111',
    businessLine: 'drywall',
    type: 'COIL',
    docType: 'FACTURA',
    series: 'F001',
    number: '1',
    issueDate: '2026-08-20',
    currency: 'PEN',
    igvRate: '18.0000',
    paymentTerms: 'CONTADO',
    items: [
      {
        description: 'Bobina',
        qty: '5000.000',
        unit: 'KGM',
        unitPrice: '4.2400',
      },
    ],
  };
  return { ...base, ...overrides };
}

function payment(
  amount: string,
  currency: Currency = Currency.PEN,
  exchangeRate = '1.0000',
  reversedAt: Date | null = null,
): BalanceablePayment {
  return { amount: dec(amount), currency, exchangeRate: dec(exchangeRate), reversedAt };
}

describe('computeTotals (D-038: el kardex se valoriza sin IGV)', () => {
  it('calcula valor de venta, IGV y total de una línea', () => {
    const totals = computeTotals(purchaseInput());
    // 5000 × 4.24 = 21 200; IGV 18 % = 3816
    expect(totals.subtotal.toFixed(4)).toBe('21200.0000');
    expect(totals.igv.toFixed(4)).toBe('3816.0000');
    expect(totals.total.toFixed(4)).toBe('25016.0000');
  });

  it('la cabecera cuadra con la suma de las líneas ya redondeadas', () => {
    const totals = computeTotals(
      purchaseInput({
        items: [
          { description: 'A', qty: '3.000', unit: 'NIU', unitPrice: '0.3333' },
          { description: 'B', qty: '3.000', unit: 'NIU', unitPrice: '0.3333' },
          { description: 'C', qty: '3.000', unit: 'NIU', unitPrice: '0.3333' },
        ],
      }),
    );
    const sumOfLines = totals.items.reduce((acc, i) => acc.plus(i.subtotal), new Decimal(0));
    expect(totals.subtotal.toFixed(4)).toBe(sumOfLines.toFixed(4));
    const sumOfTotals = totals.items.reduce((acc, i) => acc.plus(i.total), new Decimal(0));
    expect(totals.total.toFixed(4)).toBe(sumOfTotals.toFixed(4));
  });

  it('con IGV 0 (exonerado) el total es el valor de venta', () => {
    const totals = computeTotals(purchaseInput({ igvRate: '0.0000' }));
    expect(totals.igv.toFixed(4)).toBe('0.0000');
    expect(totals.total.toFixed(4)).toBe(totals.subtotal.toFixed(4));
  });
});

describe('computeDueDate', () => {
  it('suma los días de crédito a la fecha de emisión', () => {
    expect(computeDueDate(purchaseInput({ paymentTerms: 'CREDITO', creditDays: 30 }))).toBe(
      '2026-09-19',
    );
  });

  it('una compra al contado no tiene vencimiento', () => {
    expect(computeDueDate(purchaseInput())).toBeNull();
  });
});

describe('toPurchaseCurrency (D-039)', () => {
  it('un pago en la misma moneda entra tal cual', () => {
    expect(
      toPurchaseCurrency(new Decimal('500'), Currency.PEN, Currency.PEN, new Decimal('1')).toFixed(
        4,
      ),
    ).toBe('500.0000');
  });

  it('un pago en soles contra una compra en dólares se divide por el tipo de cambio', () => {
    // S/ 3750 al TC 3.75 cancelan USD 1000, no USD 3750.
    expect(
      toPurchaseCurrency(
        new Decimal('3750'),
        Currency.PEN,
        Currency.USD,
        new Decimal('3.75'),
      ).toFixed(4),
    ).toBe('1000.0000');
  });

  it('un pago en dólares contra una compra en soles se multiplica por el tipo de cambio', () => {
    expect(
      toPurchaseCurrency(
        new Decimal('100'),
        Currency.USD,
        Currency.PEN,
        new Decimal('3.75'),
      ).toFixed(4),
    ).toBe('375.0000');
  });
});

describe('purchaseBalance (D-039: pagos parciales)', () => {
  const purchasePen = { total: dec('25016.0000'), currency: Currency.PEN };

  it('sin pagos el saldo es el total', () => {
    expect(purchaseBalance(purchasePen, []).toFixed(4)).toBe('25016.0000');
    expect(paidAmount(purchasePen, []).toFixed(4)).toBe('0.0000');
  });

  it('un pago parcial reduce el saldo por su importe', () => {
    const payments = [payment('10000.0000')];
    expect(purchaseBalance(purchasePen, payments).toFixed(4)).toBe('15016.0000');
    expect(paidAmount(purchasePen, payments).toFixed(4)).toBe('10000.0000');
  });

  it('varios pagos parciales se acumulan hasta saldar la compra', () => {
    const payments = [payment('10000.0000'), payment('10000.0000'), payment('5016.0000')];
    expect(purchaseBalance(purchasePen, payments).toFixed(4)).toBe('0.0000');
    expect(paidAmount(purchasePen, payments).toFixed(4)).toBe('25016.0000');
  });

  it('un pago en soles contra una compra en dólares se convierte antes de restar', () => {
    const purchaseUsd = { total: dec('1000.0000'), currency: Currency.USD };
    // Sin la conversión, S/ 3750 habrían cancelado USD 3750 y dejado saldo negativo.
    const payments = [payment('3750.0000', Currency.PEN, '3.7500')];
    expect(purchaseBalance(purchaseUsd, payments).toFixed(4)).toBe('0.0000');
  });

  it('un pago en soles solo cancela la parte que le corresponde al tipo de cambio', () => {
    const purchaseUsd = { total: dec('1000.0000'), currency: Currency.USD };
    const payments = [payment('1875.0000', Currency.PEN, '3.7500')];
    expect(purchaseBalance(purchaseUsd, payments).toFixed(4)).toBe('500.0000');
  });

  it('un residuo de céntimos por conversión se considera saldado', () => {
    const purchaseUsd = { total: dec('1000.0000'), currency: Currency.USD };
    // 3749.98 / 3.75 = 999.9947 → quedan 0.0053, por debajo del céntimo.
    const payments = [payment('3749.9800', Currency.PEN, '3.7500')];
    expect(purchaseBalance(purchaseUsd, payments).toFixed(4)).toBe('0.0000');
  });

  it('una diferencia mayor a un céntimo sigue siendo saldo pendiente', () => {
    const payments = [payment('25015.9000')];
    expect(purchaseBalance(purchasePen, payments).toFixed(4)).toBe('0.1000');
  });
});

describe('purchaseBalance con pagos anulados (Sesión M-2, cierra D-039)', () => {
  const purchasePen = { total: dec('25016.0000'), currency: Currency.PEN };

  it('un pago anulado no cuenta para el saldo: vuelve a ser como si nunca se hubiera pagado', () => {
    const payments = [payment('10000.0000', Currency.PEN, '1.0000', new Date())];
    expect(purchaseBalance(purchasePen, payments).toFixed(4)).toBe('25016.0000');
    expect(paidAmount(purchasePen, payments).toFixed(4)).toBe('0.0000');
  });

  it('solo se descuentan los pagos vigentes cuando conviven con uno anulado', () => {
    const payments = [
      payment('10000.0000', Currency.PEN, '1.0000', new Date()),
      payment('5016.0000'),
    ];
    expect(purchaseBalance(purchasePen, payments).toFixed(4)).toBe('20000.0000');
    expect(paidAmount(purchasePen, payments).toFixed(4)).toBe('5016.0000');
  });
});
