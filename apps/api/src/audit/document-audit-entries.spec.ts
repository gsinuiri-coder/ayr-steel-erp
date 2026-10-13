import {
  cuttingInvoiceAuditEntry,
  landedCostAuditEntry,
  landedCostReverseAuditEntry,
  paymentAuditEntry,
  paymentReverseAuditEntry,
  productionCancelledBySalesOrderEntry,
  productionPlanBySalesOrderEntry,
} from './document-audit-entries';

/**
 * cc50 (D-638): cada registro va al documento cuyo «Historial» lo muestra, con lo necesario para
 * entender el cambio. Que se escriban dentro de la transacción lo prueban los db-spec
 * (`purchase-audit.db-spec.ts`, `order-qty-change.db-spec.ts`).
 */
const purchase = { id: 'p-1', series: 'F001', number: '123', supplierId: 's-1' };
const payment = { id: 'pay-1', amount: '100.0000', currency: 'PEN', method: 'TRANSFER' };

describe('pagos a proveedor', () => {
  it('el pago va a la compra, con el pago y el proveedor', () => {
    expect(paymentAuditEntry('u-1', purchase, payment, '2026-10-12')).toEqual({
      actorId: 'u-1',
      action: 'purchases.payment',
      entity: 'purchases',
      entityId: 'p-1',
      after: {
        paymentId: 'pay-1',
        supplierId: 's-1',
        document: 'F001-123',
        amount: '100.0000',
        currency: 'PEN',
        method: 'TRANSFER',
        operationDate: '2026-10-12',
      },
    });
  });

  it('la reversa también, con el motivo', () => {
    const entry = paymentReverseAuditEntry('u-1', purchase, payment, 'Pago duplicado');
    expect(entry).toMatchObject({
      action: 'purchases.payment-reverse',
      entity: 'purchases',
      entityId: 'p-1',
      before: { paymentId: 'pay-1', supplierId: 's-1', document: 'F001-123', amount: '100.0000' },
      after: { reason: 'Pago duplicado' },
    });
  });
});

describe('costo de importación', () => {
  const related = { id: 'p-2', series: 'F001', number: '9' };
  const service = { id: 'p-3', series: 'F002', number: '7', serviceKind: 'FREIGHT' };

  it('va a la compra de bobinas que lo recibe', () => {
    expect(
      landedCostAuditEntry('u-1', related, service, {
        amountPen: '80.0000',
        coils: 2,
        operationDate: '2026-10-12',
      }),
    ).toEqual({
      actorId: 'u-1',
      action: 'purchases.landed-cost',
      entity: 'purchases',
      entityId: 'p-2',
      after: {
        document: 'F001-9',
        servicePurchaseId: 'p-3',
        serviceDocument: 'F002-7',
        serviceKind: 'FREIGHT',
        amountPen: '80.0000',
        coils: 2,
        operationDate: '2026-10-12',
      },
    });
  });

  it('su reversa, al anular el servicio, también', () => {
    expect(
      landedCostReverseAuditEntry(
        'u-1',
        'p-2',
        service,
        { amountPen: '80.0000', coils: 2 },
        'Factura equivocada',
      ),
    ).toEqual({
      actorId: 'u-1',
      action: 'purchases.landed-cost-reverse',
      entity: 'purchases',
      entityId: 'p-2',
      before: { amountPen: '80.0000', coils: 2 },
      after: { servicePurchaseId: 'p-3', serviceDocument: 'F002-7', serviceKind: 'FREIGHT' },
      reason: 'Factura equivocada',
    });
  });
});

it('la factura del corte va a la orden de corte', () => {
  expect(
    cuttingInvoiceAuditEntry('u-1', 'co-1', {
      ...purchase,
      subtotal: '300.0000',
      currency: 'PEN',
    }),
  ).toEqual({
    actorId: 'u-1',
    action: 'cutting.invoice-linked',
    entity: 'cutting_orders',
    entityId: 'co-1',
    after: {
      purchaseId: 'p-1',
      document: 'F001-123',
      supplierId: 's-1',
      subtotal: '300.0000',
      currency: 'PEN',
    },
  });
});

describe('lo que el pedido le hace a sus OP', () => {
  it('anular el pedido: un registro en la OP, con el pedido y el motivo', () => {
    expect(
      productionCancelledBySalesOrderEntry(
        'u-1',
        { id: 'op-1', seq: 12, status: 'DRAFT' },
        { id: 'so-1', code: 'PED-000031' },
        'El cliente desistió',
      ),
    ).toEqual({
      actorId: 'u-1',
      action: 'production.cancel-by-sales-order',
      entity: 'production_orders',
      entityId: 'op-1',
      before: { code: 'OP-000012', status: 'DRAFT' },
      after: { status: 'CANCELLED', salesOrderId: 'so-1', salesOrder: 'PED-000031' },
      reason: 'El cliente desistió',
    });
  });

  it('cambiar la cantidad: el plan antes y después; sin motivo, no lo inventa', () => {
    const line = { salesOrderId: 'so-1', salesOrderSeq: 31, lineNumber: 2 };
    const op = { id: 'op-1', seq: 12, planMeters: '20.000' };
    const withReason = productionPlanBySalesOrderEntry('u-1', op, line, '12.000', 'Bajó');
    expect(withReason).toEqual({
      actorId: 'u-1',
      action: 'production.plan-by-sales-order',
      entity: 'production_orders',
      entityId: 'op-1',
      before: { code: 'OP-000012', planMeters: '20.000' },
      after: {
        planMeters: '12.000',
        salesOrderId: 'so-1',
        salesOrder: 'PED-000031',
        lineNumber: 2,
      },
      reason: 'Bajó',
    });
    expect(
      productionPlanBySalesOrderEntry('u-1', op, line, '12.000', undefined),
    ).not.toHaveProperty('reason');
  });
});
