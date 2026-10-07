/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { QuotationsService } from './quotations.service';
import { BadRequestException } from '@nestjs/common';

describe('QuotationsService - Reassign', () => {
  let service: QuotationsService;

  const actor = { id: 'admin1', role: 'ADMINISTRADOR', name: 'Admin', email: 'a@a.com' } as any;

  const mockPrisma = {
    user: { findUnique: jest.fn() },
    quotation: { findUnique: jest.fn(), update: jest.fn() },
    salesOrder: { findMany: jest.fn(), updateMany: jest.fn() },
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
    // cc30: la puerta (`lockDocuments`) devuelve los ids que bloqueó; la cabecera se lee después.
    mockPrisma.$queryRaw.mockImplementation((_sql: unknown, ids: string[]) =>
      Promise.resolve(ids.map((id) => ({ id }))),
    );
    mockPrisma.quotation.findUnique.mockResolvedValueOnce({
      id: 'q-1',
      seq: 1,
      status: 'DRAFT',
      validUntil: null,
      createdById: 'v-1',
      sellerId: 'v-1',
      notes: '',
    });
    mockPrisma.$transaction.mockImplementation((cb: any) => cb(mockPrisma));
    mockPrisma.quotation.update.mockResolvedValueOnce({});
    mockPrisma.salesOrder.findMany.mockResolvedValueOnce([{ id: 'so-1' }]);
    mockPrisma.salesOrder.updateMany.mockResolvedValueOnce({ count: 1 });

    jest.spyOn(service as any, 'findOne').mockResolvedValueOnce({ id: 'q-1' });

    const res = await service.reassign(actor, 'q-1', 'v-2', 'reason');
    expect(res.id).toBe('q-1');
    expect(mockPrisma.quotation.update).toHaveBeenCalledWith({
      where: { id: 'q-1' },
      data: { sellerId: 'v-2' },
    });
    // cc30 (C7): cotización → pedido, los dos por la puerta, y los pedidos antes de reescribirlos.
    const locks = (mockPrisma.$queryRaw.mock.calls as [TemplateStringsArray, string[]][]).map(
      ([sql, ids]) => [/FROM "(\w+)"/.exec(sql.join('?'))?.[1], ids],
    );
    expect(locks).toEqual([
      ['quotations', ['q-1']],
      ['sales_orders', ['so-1']],
    ]);
    expect(mockPrisma.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      mockPrisma.salesOrder.updateMany.mock.invocationCallOrder[0],
    );
    expect(mockPrisma.salesOrder.updateMany).toHaveBeenCalledWith({
      where: { quotationId: 'q-1' },
      data: { sellerId: 'v-2' },
    });
  });
});
