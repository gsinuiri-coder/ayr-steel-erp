import { createPosSaleSchema } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { PosService } from './pos.service';

/**
 * cc55 (D-666, B-01 de audit-01) — **un reintento de la venta de mostrador no vende dos veces.** Con
 * la clave ya reclamada, `sell` devuelve la venta del primero sin abrir la caja, sin pedido, sin
 * despacho, sin comprobante, sin cobro y sin reenviar al PSE. Base falsa: la de verdad está en
 * `pos-floor.db-spec.ts` (también con dos envíos simultáneos).
 */
const ADMIN = { id: 'u-admin', role: 'ADMINISTRADOR' } as RequestUser;

function build(existing: { scope: string; resourceId: string } | null) {
  const tx = {
    // `INSERT … ON CONFLICT DO NOTHING RETURNING`: sin fila, la clave ya estaba.
    $queryRaw: jest.fn().mockResolvedValue(existing === null ? [{ resource_id: 'nuevo' }] : []),
    idempotencyKey: { findUnique: jest.fn().mockResolvedValue(existing) },
  };
  const cashSessions = {
    lockOpenSession: jest.fn().mockRejectedValue(new Error('no debería abrir la caja')),
  };
  const salesOrders = { createDirectInTx: jest.fn() };
  const invoicing = { deliver: jest.fn() };
  const service = new PosService(
    { $transaction: (cb: (t: unknown) => unknown) => cb(tx) } as never,
    { write: jest.fn() } as never,
    cashSessions as never,
    salesOrders as never,
    {} as never,
    invoicing as never,
    {} as never,
  );
  const findOne = jest
    .spyOn(service, 'findOne')
    .mockImplementation((id: string) => Promise.resolve({ id } as never));
  return { service, tx, cashSessions, salesOrders, invoicing, findOne };
}

const body = createPosSaleSchema.parse({
  method: 'CASH',
  idempotencyKey: 'clave-1',
  items: [{ productId: '00000000-0000-4000-8000-000000000001', qty: '1.000', unitPricePen: '10' }],
});

describe('venta de mostrador con clave de idempotencia (cc55, D-666)', () => {
  it('con la clave ya usada devuelve la venta del primero y no repite ningún efecto', async () => {
    const s = build({ scope: 'pos-sale', resourceId: 'venta-1' });
    const sale = await s.service.sell(ADMIN, body);
    expect(sale.id).toBe('venta-1');
    expect(s.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(s.cashSessions.lockOpenSession).not.toHaveBeenCalled();
    expect(s.salesOrders.createDirectInTx).not.toHaveBeenCalled();
    expect(s.invoicing.deliver).not.toHaveBeenCalled();
    expect(s.findOne).toHaveBeenCalledWith('venta-1');
  });

  it('con la clave nueva sigue con la venta (abre la caja)', async () => {
    const s = build(null);
    await expect(s.service.sell(ADMIN, body)).rejects.toThrow('no debería abrir la caja');
    expect(s.cashSessions.lockOpenSession).toHaveBeenCalledTimes(1);
  });
});
