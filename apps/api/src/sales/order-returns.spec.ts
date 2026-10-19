import { Prisma } from '@prisma/client';
import { isFullyReturned, orderReturns } from './order-returns';

const D = (v: string) => new Prisma.Decimal(v);
const line = (qty: string, ...returned: string[]) => ({
  qty: D(qty),
  salesReturnItems: returned.map((r) => ({ qty: D(r) })),
});

describe('cc58 (D-680, D-05): pedido atendido con todo devuelto', () => {
  it('todo lo despachado volvió, sumando varias devoluciones', () => {
    expect(isFullyReturned([line('5', '2', '3'), line('1.5', '1.5')])).toBe(true);
  });

  it('una línea con algo afuera, o nada despachado, no es «devuelto entero»', () => {
    expect(isFullyReturned([line('5', '5'), line('2', '1.999')])).toBe(false);
    expect(isFullyReturned([line('5')])).toBe(false);
    expect(isFullyReturned([])).toBe(false);
  });

  it('lista las DEV- vivas con su NC y lee solo lo despachado con movimiento', async () => {
    const salesReturn = {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'r-1', seq: 7, creditNote: { id: 'nc-1', number: 'FC01-00000045' } },
        ]),
    };
    const dispatchItem = { findMany: jest.fn().mockResolvedValue([line('3', '3')]) };
    const out = await orderReturns({ salesReturn, dispatchItem } as never, 'o-1');
    expect(out).toEqual({
      returns: [
        { id: 'r-1', code: 'DEV-000007', creditNoteId: 'nc-1', creditNoteNumber: 'FC01-00000045' },
      ],
      fullyReturned: true,
    });
    expect(salesReturn.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { salesOrderId: 'o-1', status: 'ACTIVE' } }),
    );
    expect(dispatchItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { movementId: { not: null }, dispatch: { salesOrderId: 'o-1', status: 'ISSUED' } },
      }),
    );
  });
});
