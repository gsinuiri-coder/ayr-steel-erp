import { ConflictException } from '@nestjs/common';
import { assertNoLiveDocumentClash } from './purchase-document-clash';

/** cc33 (ceros a la izquierda): el choque entre compras vivas se compara sin ceros. */
function txWith(numbers: string[]) {
  const findMany = jest
    .fn()
    .mockResolvedValue(numbers.map((number) => ({ series: 'F001', number })));
  return { tx: { purchase: { findMany } }, findMany };
}

const DOC = { supplierId: 'sup-1', docType: 'FACTURA' as const, series: 'F001' };

describe('assertNoLiveDocumentClash', () => {
  it('F001-12 choca con una viva F001-00012 del mismo proveedor', async () => {
    const { tx } = txWith(['00012']);
    await expect(assertNoLiveDocumentClash(tx as never, { ...DOC, number: '12' })).rejects.toThrow(
      ConflictException,
    );
    await expect(assertNoLiveDocumentClash(tx as never, { ...DOC, number: '12' })).rejects.toThrow(
      '(F001-00012)',
    );
  });

  it('otro número no choca', async () => {
    const { tx } = txWith(['00013', '120']);
    await expect(
      assertNoLiveDocumentClash(tx as never, { ...DOC, number: '12' }),
    ).resolves.toBeUndefined();
  });

  it('busca solo vivas, de ese proveedor, tipo y serie, sin la que se corrige', async () => {
    const { tx, findMany } = txWith([]);
    await assertNoLiveDocumentClash(tx as never, { ...DOC, number: '12', excludeId: 'pu-1' });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          supplierId: 'sup-1',
          docType: 'FACTURA',
          series: 'F001',
          status: { not: 'CANCELLED' },
          id: { not: 'pu-1' },
        }),
      }),
    );
  });
});
