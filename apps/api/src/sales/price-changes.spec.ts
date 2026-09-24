import { Prisma } from '@prisma/client';
import { recordPriceChanges, type PricedLine } from './price-changes';

/**
 * D-187/D-264: qué registra `recordPriceChanges`. Es lo que el barrido de lo importado lee como
 * «editada a propósito», así que un cambio sin registro es un precio que el barrido pisaría.
 */

const D = (v: string) => new Prisma.Decimal(v);
const priced = (lineNumber: number, productId: string, unit: string): PricedLine => ({
  lineNumber,
  productId,
  unitPricePen: D(unit),
  valuePerMeterPen: null,
});

function fakeTx() {
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  return {
    tx: { salesPriceChange: { createMany } } as unknown as Prisma.TransactionClient,
    createMany,
  };
}
const rows = (createMany: jest.Mock) =>
  (createMany.mock.calls[0]?.[0] as { data: Record<string, unknown>[] } | undefined)?.data ?? [];

describe('recordPriceChanges', () => {
  it('registra el precio que cambió en el mismo producto', async () => {
    const { tx, createMany } = fakeTx();
    const n = await recordPriceChanges(
      tx,
      { quotationId: 'q-1' },
      [priced(1, 'p-1', '10.0000')],
      [priced(1, 'p-1', '9.0000')],
      'u-1',
    );
    expect(n).toBe(1);
    expect(rows(createMany)[0]).toMatchObject({
      productId: 'p-1',
      beforeUnitValuePen: '10',
      afterUnitValuePen: '9',
    });
  });

  it('sin cambio de precio no registra nada', async () => {
    const { tx, createMany } = fakeTx();
    const n = await recordPriceChanges(
      tx,
      { quotationId: 'q-1' },
      [priced(1, 'p-1', '10.0000'), priced(2, 'p-2', '5.0000')],
      [priced(1, 'p-2', '5.0000'), priced(2, 'p-1', '10.0000')],
      'u-1',
    );
    expect(n).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('D-264: producto y precio cambiados en la misma edición se registran con el producto nuevo', async () => {
    const { tx, createMany } = fakeTx();
    const n = await recordPriceChanges(
      tx,
      { quotationId: 'q-1' },
      [priced(1, 'p-mal-mapeado', '10.0000'), priced(2, 'p-2', '5.0000')],
      [priced(1, 'p-correcto', '8.0000'), priced(2, 'p-2', '5.0000')],
      'u-1',
    );
    expect(n).toBe(1);
    expect(rows(createMany)[0]).toMatchObject({
      lineNumber: 1,
      productId: 'p-correcto',
      beforeUnitValuePen: '10',
      afterUnitValuePen: '8',
    });
  });

  it('cambiar solo el producto, al mismo precio, no es un cambio de precio', async () => {
    const { tx, createMany } = fakeTx();
    const n = await recordPriceChanges(
      tx,
      { quotationId: 'q-1' },
      [priced(1, 'p-mal-mapeado', '10.0000')],
      [priced(1, 'p-correcto', '10.0000')],
      'u-1',
    );
    expect(n).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('una línea agregada al final no es un cambio de precio', async () => {
    const { tx } = fakeTx();
    const n = await recordPriceChanges(
      tx,
      { quotationId: 'q-1' },
      [priced(1, 'p-1', '10.0000')],
      [priced(1, 'p-1', '10.0000'), priced(2, 'p-2', '7.0000')],
      'u-1',
    );
    expect(n).toBe(0);
  });
});
