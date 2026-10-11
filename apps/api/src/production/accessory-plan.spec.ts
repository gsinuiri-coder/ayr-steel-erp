import { Prisma } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import { accessoryPlanMeters, accessoryPlans } from './accessory-plan';

const D = (v: string) => new Prisma.Decimal(v);
const row = (orderId: string, line: string, meters: string | null) => ({
  productionOrderId: orderId,
  metersM: meters === null ? null : D(meters),
  productionOrder: { reservation: { salesOrderItemId: line } },
});

function db(rows: ReturnType<typeof row>[]) {
  return { productionReport: { findMany: jest.fn().mockResolvedValue(rows) } };
}

describe('D-605 (cc45) — el plan de una orden de accesorio', () => {
  it('sin órdenes no consulta nada', async () => {
    const fake = db([]);
    expect((await accessoryPlans(fake as never, [])).size).toBe(0);
    expect(fake.productionReport.findMany).not.toHaveBeenCalled();
  });

  it('una sola orden: los metros de la línea, como siempre (PED con 6 m registrados de 5)', async () => {
    const plans = await accessoryPlans(db([row('op-1', 'l-1', '6.000')]) as never, [
      { orderId: 'op-1', salesOrderItemId: 'l-1', lineQty: new Decimal('5'), closed: true },
    ]);
    expect(plans.get('op-1')?.toFixed(3)).toBe('5.000');
  });

  it('con una orden nueva por la diferencia: cada una descuenta a sus hermanas', async () => {
    const plans = await accessoryPlans(
      db([
        row('op-1', 'l-1', '3.000'),
        row('op-1', 'l-1', '2.000'),
        row('op-2', 'l-1', '0.500'),
        row('op-9', 'l-9', '99.000'),
        row('op-2', 'l-1', null),
      ]) as never,
      [
        // La cerrada fabricó 5 y la línea subió a 6,5: su plan sigue siendo 5.
        { orderId: 'op-1', salesOrderItemId: 'l-1', lineQty: new Decimal('6.5'), closed: true },
        { orderId: 'op-2', salesOrderItemId: 'l-1', lineQty: new Decimal('6.5') },
      ],
    );
    expect(plans.get('op-1')?.toFixed(3)).toBe('5.000');
    expect(plans.get('op-2')?.toFixed(3)).toBe('1.500');
  });

  it('nunca negativo', async () => {
    const plans = await accessoryPlans(db([row('op-1', 'l-1', '8.000')]) as never, [
      { orderId: 'op-2', salesOrderItemId: 'l-1', lineQty: new Decimal('5') },
    ]);
    expect(plans.get('op-2')?.toFixed(3)).toBe('0.000');
  });

  it('accessoryPlanMeters lee la línea de la reserva', async () => {
    const tx = {
      ...db([row('op-1', 'l-1', '4.000')]),
      reservation: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ salesOrderItemId: 'l-1', salesOrderItem: { qty: D('10') } }),
      },
    };
    expect((await accessoryPlanMeters(tx as never, 'op-2', 'res-1')).toFixed(3)).toBe('6.000');
  });
});
