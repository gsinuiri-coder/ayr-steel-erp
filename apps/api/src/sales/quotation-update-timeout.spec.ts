import { QuotationsService } from './quotations.service';

/**
 * Ensayo en demo de RF-S4b: la edición de una cotización valida el pool de bobinas en el
 * servidor (D-254) y eso suma consultas. Con los 5 s por defecto de Prisma, el barrido contra
 * Neon vencía la transacción a mitad («Transaction not found»). Se fija el margen.
 */
describe('QuotationsService.update — margen de la transacción', () => {
  it('abre la transacción con 30 s de timeout, como la edición de pedidos', async () => {
    const $transaction = jest.fn().mockRejectedValue(new Error('corte del test'));
    const svc = Object.create(QuotationsService.prototype) as QuotationsService;
    Object.assign(svc, { prisma: { $transaction } });
    await expect(
      svc.update({ id: 'u-1' } as never, 'q-1', {
        customerId: 'c-1',
        issueDate: '2026-09-24',
        validityDays: 7,
        items: [],
      }),
    ).rejects.toThrow('corte del test');
    expect(($transaction.mock.calls as unknown[][])[0]?.[1]).toEqual({
      timeout: 30_000,
      maxWait: 10_000,
    });
  });
});
