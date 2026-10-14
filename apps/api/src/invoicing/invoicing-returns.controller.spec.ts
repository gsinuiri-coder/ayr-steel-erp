import { Role } from '@prisma/client';
import type { RequestUser } from '../auth/auth.types';
import { InvoicingController } from './invoicing.controller';

/** cc52 (D-646): el documento de devolución; el costo, solo para el ADMINISTRADOR. */
describe('InvoicingController.findReturn (cc52)', () => {
  const dto = {
    id: 'sr-1',
    code: 'DEV-000001',
    totalCostPen: '40.0000',
    items: [{ lineNumber: 1, unitCostPen: '20.0000', totalCostPen: '40.0000' }],
  };
  function controller() {
    const salesReturns = {
      assertSellerAccessTo: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(dto),
    };
    const c = new InvoicingController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      salesReturns as never,
    );
    return { c, salesReturns };
  }

  it('el ADMINISTRADOR ve el costo', async () => {
    const { c, salesReturns } = controller();
    await expect(
      c.findReturn({ id: 'u-1', role: Role.ADMINISTRADOR } as RequestUser, 'sr-1'),
    ).resolves.toEqual(dto);
    expect(salesReturns.assertSellerAccessTo).toHaveBeenCalled();
  });

  it('otro rol, sin costo', async () => {
    const { c } = controller();
    const out = await c.findReturn({ id: 'u-2', role: Role.VENDEDOR } as RequestUser, 'sr-1');
    expect(out.totalCostPen).toBeNull();
    expect(out.items[0]).toMatchObject({ unitCostPen: null, totalCostPen: null });
  });
});
