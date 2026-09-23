import { BusinessLineCode, CoilKind, CoilStatus, FinishKind, type Prisma } from '@prisma/client';
import { openCoilCodesInPool } from './coil-sale-product';

/**
 * **D-257 (aclaración) — un producto de venta de bobina no se desactiva con bobinas abiertas.**
 * Lo que decide si hay bobinas es el pool: espesor exacto y mismo color comercial o tipo (ROJO y
 * ROJO-3020 juntos), abiertas y con saldo. Las cerradas, las de otro color y las sin saldo no
 * cuentan.
 */

const PRODUCT = {
  sku: 'BOB038ROJO',
  name: 'Bobina Rojo 0.38 mm',
  businessLine: { code: BusinessLineCode.TRADING },
};

function coil(id: string, code: string, colorCode: string | null, kind = FinishKind.PREPINTADO) {
  return {
    id,
    code,
    finish: { kind, color: colorCode === null ? null : { code: colorCode } },
  };
}

function txWith(coils: ReturnType<typeof coil>[], withBalance: string[]): Prisma.TransactionClient {
  return {
    color: { findMany: jest.fn().mockResolvedValue([{ code: 'ROJO' }, { code: 'ROJO-3020' }]) },
    coil: { findMany: jest.fn().mockResolvedValue(coils) },
    inventoryBalance: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: { where: { itemId: { in: string[] } } }) =>
          Promise.resolve(
            where.itemId.in.filter((id) => withBalance.includes(id)).map((itemId) => ({ itemId })),
          ),
        ),
    },
  } as unknown as Prisma.TransactionClient;
}

describe('openCoilCodesInPool', () => {
  it('cuenta las bobinas del pool con saldo, ROJO y ROJO-3020 juntos', async () => {
    const tx = txWith(
      [coil('c1', 'B-1', 'ROJO'), coil('c2', 'B-2', 'ROJO-3020'), coil('c3', 'B-3', 'AZUL')],
      ['c1', 'c2', 'c3'],
    );
    await expect(openCoilCodesInPool(tx, PRODUCT)).resolves.toEqual(['B-1', 'B-2']);
  });

  it('una bobina sin saldo no cuenta', async () => {
    const tx = txWith([coil('c1', 'B-1', 'ROJO'), coil('c2', 'B-2', 'ROJO')], ['c2']);
    await expect(openCoilCodesInPool(tx, PRODUCT)).resolves.toEqual(['B-2']);
  });

  it('sin bobinas en el pool, se puede desactivar', async () => {
    const tx = txWith([coil('c3', 'B-3', 'AZUL')], ['c3']);
    await expect(openCoilCodesInPool(tx, PRODUCT)).resolves.toEqual([]);
  });

  it('filtra por bobina abierta y espesor exacto en la consulta', async () => {
    const tx = txWith([], []);
    await openCoilCodesInPool(tx, PRODUCT);
    const calls = (tx.coil.findMany as jest.Mock).mock.calls as [
      { where: { kind: CoilKind; status: CoilStatus; thicknessMm: string } },
    ][];
    expect(calls[0]?.[0].where).toMatchObject({
      kind: CoilKind.COIL,
      status: CoilStatus.OPEN,
      thicknessMm: '0.38',
    });
  });

  it('un producto que no es de bobina no tiene pool', async () => {
    const tx = txWith([], []);
    await expect(
      openCoilCodesInPool(tx, { ...PRODUCT, sku: 'COB040ROJO', name: 'Cobertura' }),
    ).resolves.toEqual([]);
  });
});
