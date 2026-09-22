/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { QuotationsService } from './quotations.service';
import { BadRequestException } from '@nestjs/common';

describe('QuotationsService - Reassign', () => {
  let service: QuotationsService;

  const actor = { id: 'admin1', role: 'ADMINISTRADOR', name: 'Admin', email: 'a@a.com' } as any;

  const mockPrisma = {
    user: { findUnique: jest.fn() },
    quotation: { update: jest.fn() },
    salesOrder: { updateMany: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  } as any;

  beforeEach(() => {
    service = new QuotationsService(
      mockPrisma,
      { write: jest.fn() } as any, // audit
      {} as any, // storage
      {} as any, // orders
      {} as any, // env
    );
  });

  it('arroja 400 si el nuevo vendedor no existe o no es VENDEDOR', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.reassign(actor, 'q-1', 'v-2', 'reason')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('pasa si el nuevo vendedor es VENDEDOR activo', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'v-2',
      role: 'VENDEDOR',
      isActive: true,
    });
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        id: 'q-1',
        seq: 1,
        status: 'DRAFT',
        valid_until: null,
        created_by_id: 'v-1',
        seller_id: 'v-1',
        notes: '',
      },
    ]);
    mockPrisma.$transaction.mockImplementation((cb: any) => cb(mockPrisma));
    mockPrisma.quotation.update.mockResolvedValueOnce({});
    mockPrisma.salesOrder.updateMany.mockResolvedValueOnce({ count: 1 });

    jest.spyOn(service as any, 'findOne').mockResolvedValueOnce({ id: 'q-1' });

    const res = await service.reassign(actor, 'q-1', 'v-2', 'reason');
    expect(res.id).toBe('q-1');
    expect(mockPrisma.quotation.update).toHaveBeenCalledWith({
      where: { id: 'q-1' },
      data: { sellerId: 'v-2' },
    });
  });
});
