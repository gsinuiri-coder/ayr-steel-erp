import { describe, expect, it } from 'vitest';
import type { ProductionOrderListItemDto } from '@ayr/shared';
import { deriveGroupStatus, groupHistoryByOrder } from './order-history';

function op(overrides: Partial<ProductionOrderListItemDto>): ProductionOrderListItemDto {
  return {
    id: 'op',
    code: 'OP-000001',
    status: 'CLOSED',
    salesOrderId: 'so-1',
    salesOrderCode: 'PED-000001',
    customerName: 'Cliente',
    operationDate: '2026-09-10',
    planMeters: null,
    metersReported: null,
    ...overrides,
  } as ProductionOrderListItemDto;
}

describe('deriveGroupStatus (D-291)', () => {
  it('manda lo que sigue vivo', () => {
    expect(deriveGroupStatus(['CLOSED', 'IN_PROGRESS', 'DRAFT'])).toBe('IN_PROGRESS');
    expect(deriveGroupStatus(['CLOSED', 'DRAFT'])).toBe('DRAFT');
  });

  it('con todo terminado es cerrada, aunque haya anuladas mezcladas', () => {
    expect(deriveGroupStatus(['CLOSED', 'CLOSED'])).toBe('CLOSED');
    expect(deriveGroupStatus(['CLOSED', 'CANCELLED'])).toBe('CLOSED');
  });

  it('solo anuladas es anulada', () => {
    expect(deriveGroupStatus(['CANCELLED', 'CANCELLED'])).toBe('CANCELLED');
  });
});

describe('groupHistoryByOrder (D-291)', () => {
  it('una fila por pedido, con cerradas/total y ML plan/reportado sumados como Decimal', () => {
    const groups = groupHistoryByOrder([
      op({ id: 'a', status: 'CLOSED', planMeters: '10.500', metersReported: '10.500' }),
      op({
        id: 'b',
        status: 'IN_PROGRESS',
        planMeters: '4.250',
        metersReported: '0.100',
        operationDate: '2026-09-12',
      }),
      op({ id: 'c', salesOrderId: 'so-2', salesOrderCode: 'PED-000002' }),
    ]);
    expect(groups).toHaveLength(2);
    const first = groups[0];
    expect(first?.orders.map((o) => o.id)).toEqual(['a', 'b']);
    expect(first?.closedCount).toBe(1);
    expect(first?.planMeters).toBe('14.750');
    // 10.500 + 0.100: con `number` daría 10.600000000000001 en otros casos; con Decimal, exacto.
    expect(first?.reportedMeters).toBe('10.600');
    expect(first?.date).toBe('2026-09-12');
    expect(first?.status).toBe('IN_PROGRESS');
  });

  it('las corridas a stock (sin pedido) forman su propio grupo y no tienen ML', () => {
    const [group] = groupHistoryByOrder([op({ salesOrderId: null, salesOrderCode: null })]);
    expect(group?.key).toBe('sin-pedido');
    expect(group?.planMeters).toBeNull();
    expect(group?.reportedMeters).toBeNull();
  });
});
