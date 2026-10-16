import { Decimal } from '@ayr/shared';
import { planReturnAllocation, type DispatchLineStock } from './sales-return-allocation';
import { liveInvoiceId } from './sales-returns.service';

/**
 * cc55 (D-664, D-04 de audit-01) — **un despacho enlazado a un comprobante que ya no está vivo
 * cuenta como «sin comprobante declarado».** Antes de cc55 la anulación interna no soltaba
 * `dispatches.invoice_id` (D-205), y la NC 01 (D-656, `onlyAffected`) sobre el comprobante
 * corregido no devolvía ese despacho: sin DEV-, la línea «pendiente de facturar» y el stock afuera.
 * Es la demostración de `local-data/audit-01/specs/audit-d-return-allocation.spec.ts`, ahora con el
 * resultado correcto.
 */
function stock(over: Partial<DispatchLineStock> = {}): DispatchLineStock {
  return {
    dispatchItemId: 'di-1',
    dispatchId: 'd-1',
    dispatchCode: 'DES-000001',
    dispatchDate: '2026-10-01',
    dispatchSeq: 1,
    invoiceId: null,
    itemType: 'PRODUCT',
    itemId: 'p-1',
    qty: new Decimal('10'),
    reserveQty: new Decimal('10'),
    returnedQty: new Decimal(0),
    returnedReserveQty: new Decimal(0),
    returnedTotalCost: new Decimal(0),
    movementId: 1n,
    unitCost: new Decimal('5'),
    totalCost: new Decimal('50'),
    unit: 'NIU',
    businessLineId: 'bl',
    ...over,
  };
}

const OPTIONS = {
  affectedInvoiceId: 'F2',
  asOf: '2026-10-15',
  upToAvailable: true,
  onlyAffected: true,
} as const;

describe('liveInvoiceId', () => {
  it('un comprobante vivo y vigente declara el despacho', () => {
    expect(liveInvoiceId('F1', { status: 'ACCEPTED', archivedAt: null })).toBe('F1');
    expect(liveInvoiceId('F1', { status: 'ISSUED', archivedAt: null })).toBe('F1');
  });

  it.each(['ANNULLED', 'VOIDED', 'REJECTED', 'DRAFT'])('uno %s no declara nada', (status) => {
    expect(liveInvoiceId('F1', { status, archivedAt: null })).toBeNull();
  });

  it('una versión archivada (RF-72) no declara nada', () => {
    expect(liveInvoiceId('F1', { status: 'ACCEPTED', archivedAt: new Date() })).toBeNull();
  });

  it('sin enlace, sin comprobante', () => {
    expect(liveInvoiceId(null, null)).toBeNull();
    expect(liveInvoiceId('F1', null)).toBeNull();
  });
});

describe('D-04 · 01 sobre el comprobante corregido, con el despacho del anulado', () => {
  it('el enlace muerto ya no cuenta como «de otro comprobante»: el 01 devuelve el despacho', () => {
    const invoiceId = liveInvoiceId('F1-anulada', { status: 'ANNULLED', archivedAt: null });
    const plan = planReturnAllocation(1, new Decimal('10'), [stock({ invoiceId })], OPTIONS);
    expect(plan.map((a) => [a.qty.toFixed(3), a.totalCost.toFixed(4)])).toEqual([
      ['10.000', '50.0000'],
    ]);
  });

  it('el despacho de otro comprobante vivo sigue sin devolverse por el 01', () => {
    const invoiceId = liveInvoiceId('F3', { status: 'ACCEPTED', archivedAt: null });
    expect(planReturnAllocation(1, new Decimal('10'), [stock({ invoiceId })], OPTIONS)).toEqual([]);
  });
});
