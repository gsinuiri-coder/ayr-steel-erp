import {
  BusinessLineCode,
  CoilStatus,
  FinishKind,
  InventoryItemType,
  Prisma,
  Role,
} from '@prisma/client';
import {
  assertNoBaseCollision,
  coilPoolFor,
  coilPoolKeyOf,
  coilPoolKeyOfProduct,
  coilSaleSkus,
  ensureCoilSaleProduct,
  findCoilSaleProducts,
  isCoilSaleProduct,
  knownCoilAttributes,
  lineCoilPool,
} from './coil-sale-product';

const mockMounted = jest.fn().mockResolvedValue([]);
const mockReserved = jest.fn().mockResolvedValue(new Map());
jest.mock('../production/production-assignments', () => ({
  findLiveStripAssignments: (...args: unknown[]) => mockMounted(...args) as unknown,
}));
jest.mock('./reserved-ledger', () => ({
  reservedByItem: (...args: unknown[]) => mockReserved(...args) as unknown,
}));

/**
 * D-252/D-253/D-254 — la resolución bobina → producto y el pool, con una base falsa. Lo que se
 * fija: el canónico manda sobre el viejo, un producto inactivo nunca resuelve, y el pool solo
 * ofrece bobinas libres con saldo, eligiendo sola únicamente cuando no hay ambigüedad.
 */

const ROJO = { code: 'ROJO' };
const identity = (colorCode = 'ROJO', finishCode = 'ALZ-ROJO-3002', thickness = '0.38') => ({
  thicknessMm: thickness,
  finish: { code: finishCode, kind: FinishKind.PREPINTADO, color: { code: colorCode } },
});

describe('coilSaleSkus / coilPoolKeyOf', () => {
  it('el canónico ignora el RAL y el viejo conserva el código del acabado', () => {
    expect(coilSaleSkus(identity('ROJO-3020', 'ALZ-ROJO-3020'))).toEqual({
      canonical: 'BOB038ROJO',
      legacy: 'BOBALZ-ROJO-30200.38',
    });
  });

  it('el pool de una bobina es su SKU, su espesor y su color comercial', () => {
    expect(coilPoolKeyOf(identity('ROJO-3020'))).toEqual({
      sku: 'BOB038ROJO',
      thicknessMm: '0.38',
      attribute: 'ROJO',
    });
  });

  it('un prepintado sin color no tiene pool', () => {
    expect(
      coilPoolKeyOf({
        thicknessMm: '0.38',
        finish: { code: 'X', kind: FinishKind.PREPINTADO, color: null },
      }),
    ).toBeNull();
  });
});

describe('isCoilSaleProduct', () => {
  it('solo los BOB… de la línea de reventa', () => {
    const trading = { code: BusinessLineCode.TRADING };
    expect(isCoilSaleProduct({ sku: 'bob038rojo', businessLine: trading })).toBe(true);
    expect(isCoilSaleProduct({ sku: 'COB040ROJO', businessLine: trading })).toBe(false);
    expect(
      isCoilSaleProduct({ sku: 'BOB038ROJO', businessLine: { code: BusinessLineCode.DRYWALL } }),
    ).toBe(false);
  });
});

describe('findCoilSaleProducts', () => {
  const product = (id: string, sku: string) => ({ id, sku, name: sku, businessLineId: 'bl-t' });
  const txWith = (products: ReturnType<typeof product>[], trading = true) =>
    ({
      businessLine: { findUnique: jest.fn().mockResolvedValue(trading ? { id: 'bl-t' } : null) },
      product: { findMany: jest.fn().mockResolvedValue(products) },
    }) as unknown as Prisma.TransactionClient;

  it('el canónico gana sobre el viejo', async () => {
    const tx = txWith([product('p-old', 'BOBALZ-ROJO-30020.38'), product('p-new', 'BOB038ROJO')]);
    const found = await findCoilSaleProducts(tx, [identity()]);
    expect(found.get('BOB038ROJO')?.id).toBe('p-new');
  });

  it('cae al viejo durante la transición', async () => {
    const tx = txWith([product('p-old', 'BOBALZ-ROJO-30020.38')]);
    const found = await findCoilSaleProducts(tx, [identity()]);
    expect(found.get('BOB038ROJO')?.id).toBe('p-old');
  });

  it('pide solo activos', async () => {
    const tx = txWith([]);
    await findCoilSaleProducts(tx, [identity()]);
    const calls = (tx.product.findMany as jest.Mock).mock.calls as [
      { where: { isActive: boolean } },
    ][];
    expect(calls[0]?.[0].where.isActive).toBe(true);
  });

  it('sin línea de reventa o sin identidades, no resuelve nada', async () => {
    expect((await findCoilSaleProducts(txWith([], false), [identity()])).size).toBe(0);
    expect((await findCoilSaleProducts(txWith([]), [])).size).toBe(0);
  });
});

describe('knownCoilAttributes', () => {
  it('incluye los colores del catálogo sin RAL y los tipos, y descarta un color solo-RAL', async () => {
    const tx = {
      color: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ code: 'ROJO' }, { code: 'ROJO-3020' }, { code: 'RAL9010' }]),
      },
    } as unknown as Prisma.TransactionClient;
    const known = await knownCoilAttributes(tx);
    expect([...known].sort()).toEqual(['GALVANIZADO', 'NATURAL', 'ROJO']);
  });
});

describe('coilPoolKeyOfProduct / lineCoilPool', () => {
  const trading = { code: BusinessLineCode.TRADING };
  const txWith = (finish: unknown = null) =>
    ({
      color: { findMany: jest.fn().mockResolvedValue([ROJO, { code: 'AZUL' }]) },
      finish: { findUnique: jest.fn().mockResolvedValue(finish) },
      coil: { findUnique: jest.fn() },
    }) as unknown as Prisma.TransactionClient;

  it('interpreta el código del origen suelto (BOB38AZUL)', async () => {
    const key = await coilPoolKeyOfProduct(txWith(), {
      sku: 'BOB38AZUL',
      name: 'x',
      businessLine: trading,
    });
    expect(key).toEqual({ sku: 'BOB038AZUL', thicknessMm: '0.38', attribute: 'AZUL' });
  });

  it('reconoce el SKU viejo por el código del acabado', async () => {
    const tx = txWith({
      code: 'ALZ-ROJO-3002',
      kind: FinishKind.PREPINTADO,
      color: { code: 'ROJO' },
    });
    const key = await coilPoolKeyOfProduct(tx, {
      sku: 'BOBALZ-ROJO-30020.38',
      name: 'Bobina',
      businessLine: trading,
    });
    expect(key?.sku).toBe('BOB038ROJO');
  });

  it('un SKU viejo con un acabado que no existe no tiene pool', async () => {
    const key = await coilPoolKeyOfProduct(txWith(null), {
      sku: 'BOBFANTASMA0.38',
      name: 'x',
      businessLine: trading,
    });
    expect(key).toBeNull();
  });

  it('un producto que no es de bobina no tiene pool', async () => {
    expect(
      await coilPoolKeyOfProduct(txWith(), { sku: 'COB040ROJO', name: 'x', businessLine: trading }),
    ).toBeNull();
  });

  it('una línea que ya vende una bobina toma el pool de esa bobina', async () => {
    const tx = txWith();
    (tx.coil.findUnique as jest.Mock).mockResolvedValue(identity());
    const key = await lineCoilPool(tx, {
      description: '',
      reserveItemType: InventoryItemType.COIL,
      reserveItemId: 'c-1',
      product: { sku: 'BOB038ROJO', name: 'x', businessLine: trading },
    });
    expect(key?.sku).toBe('BOB038ROJO');
  });

  it('una línea enganchada a un BOB suelto toma el pool del producto', async () => {
    const key = await lineCoilPool(txWith(), {
      description: 'BOBINA ALUZINC AZUL 0.38 X 1200',
      reserveItemType: InventoryItemType.PRODUCT,
      reserveItemId: 'p-1',
      product: { sku: 'BOB38AZUL', name: 'x', businessLine: trading },
    });
    expect(key?.sku).toBe('BOB038AZUL');
  });
});

describe('assertNoBaseCollision / ensureCoilSaleProduct', () => {
  const finish = (density: string, colorCode = 'ROJO') => ({
    id: 'f-1',
    code: 'ALZ-ROJO-3002',
    name: 'Aluzinc rojo',
    kind: FinishKind.PREPINTADO,
    densityFactor: new Prisma.Decimal(density),
    businessLineId: 'bl-r',
    color: { code: colorCode },
  });
  const sibling = (density: string, colorCode = 'ROJO-3020') => ({
    code: 'ALZ-ROJO-3020',
    kind: FinishKind.PREPINTADO,
    densityFactor: new Prisma.Decimal(density),
    businessLineId: 'bl-r',
    color: { code: colorCode },
  });
  const txWith = (siblings: unknown[], existing: unknown = null) =>
    ({
      businessLine: { findUnique: jest.fn().mockResolvedValue({ id: 'bl-t' }) },
      finish: { findMany: jest.fn().mockResolvedValue(siblings) },
      product: {
        findUnique: jest.fn().mockResolvedValue(existing),
        upsert: jest.fn().mockResolvedValue({}),
      },
    }) as unknown as Prisma.TransactionClient;

  it('dos prepintados del mismo color comercial con la misma densidad no chocan', async () => {
    await expect(
      assertNoBaseCollision(txWith([sibling('7.85')]), finish('7.85')),
    ).resolves.toBeUndefined();
  });

  it('con distinta densidad chocan, nombrando los dos acabados', async () => {
    await expect(assertNoBaseCollision(txWith([sibling('7.20')]), finish('7.85'))).rejects.toThrow(
      /ALZ-ROJO-3002 y ALZ-ROJO-3020/,
    );
  });

  it('un tipo sin color (NATURAL) no mira hermanos', async () => {
    const tx = txWith([]);
    await assertNoBaseCollision(tx, { ...finish('7.85'), kind: FinishKind.NATURAL, color: null });
    expect(tx.finish.findMany).not.toHaveBeenCalled();
  });

  it('crea el producto canónico si no existe', async () => {
    const tx = txWith([]);
    await ensureCoilSaleProduct(tx, finish('7.85'), '0.38');
    const calls = (tx.product.upsert as jest.Mock).mock.calls as [
      { create: { sku: string; unit: string } },
    ][];
    expect(calls[0]?.[0].create).toMatchObject({ sku: 'BOB038ROJO', unit: 'KGM' });
  });

  it('si el canónico ya existe no lo toca ni mira el choque de base', async () => {
    const tx = txWith([sibling('1.00')], { id: 'p-1' });
    await ensureCoilSaleProduct(tx, finish('7.85'), '0.38');
    expect(tx.product.upsert).not.toHaveBeenCalled();
    expect(tx.finish.findMany).not.toHaveBeenCalled();
  });
});

describe('coilPoolFor', () => {
  const coil = (id: string, colorCode: string, width = '1200') => ({
    id,
    code: `B-${id}`,
    widthMm: new Prisma.Decimal(width),
    finish: { kind: FinishKind.PREPINTADO, color: { code: colorCode } },
  });
  const txWith = (
    coils: ReturnType<typeof coil>[],
    balances: Record<string, string>,
    quoted: string[] = [],
    quotedSellerId: string | null = 'v-1',
  ) =>
    ({
      coil: { findMany: jest.fn().mockResolvedValue(coils) },
      inventoryBalance: {
        findMany: jest.fn().mockResolvedValue(
          Object.entries(balances).map(([itemId, qty]) => ({
            itemId,
            qty: new Prisma.Decimal(qty),
          })),
        ),
      },
      quotationItem: {
        findMany: jest.fn().mockResolvedValue(
          quoted.map((reserveItemId) => ({
            reserveItemId,
            quotation: { seq: 2, sellerId: quotedSellerId },
          })),
        ),
      },
    }) as unknown as Prisma.TransactionClient;
  const pool = { thicknessMm: '0.38', attribute: 'ROJO' };

  beforeEach(() => {
    mockMounted.mockResolvedValue([]);
    mockReserved.mockResolvedValue(new Map());
  });

  it('una sola candidata: se elige sola', async () => {
    const r = await coilPoolFor(txWith([coil('1', 'ROJO')], { '1': '4194' }), pool, '4194');
    expect(r.autoCoilId).toBe('1');
    expect(r.candidates).toHaveLength(1);
    expect(r.availableKg).toBe('4194.000');
  });

  it('ROJO y ROJO-3020 son el mismo pool', async () => {
    const r = await coilPoolFor(
      txWith([coil('1', 'ROJO'), coil('2', 'ROJO-3020'), coil('3', 'AZUL')], {
        '1': '5000',
        '2': '5000',
        '3': '5000',
      }),
      pool,
      '4000',
    );
    expect(r.candidates.map((c) => c.coilId)).toEqual(['1', '2']);
  });

  it('varias candidatas y ninguna de saldo exacto: no se elige (nunca por orden)', async () => {
    const r = await coilPoolFor(
      txWith([coil('1', 'ROJO'), coil('2', 'ROJO')], { '1': '5000', '2': '6000' }),
      pool,
      '4000',
    );
    expect(r.autoCoilId).toBeNull();
    expect(r.candidates).toHaveLength(2);
  });

  it('varias candidatas pero exactamente una con el saldo del papel: se elige esa', async () => {
    const r = await coilPoolFor(
      txWith([coil('1', 'ROJO'), coil('2', 'ROJO')], { '1': '5000', '2': '4194' }),
      pool,
      '4194',
    );
    expect(r.autoCoilId).toBe('2');
  });

  it('dos de saldo exacto: no se elige', async () => {
    const r = await coilPoolFor(
      txWith([coil('1', 'ROJO'), coil('2', 'ROJO')], { '1': '4194', '2': '4194' }),
      pool,
      '4194',
    );
    expect(r.autoCoilId).toBeNull();
  });

  it('una bobina con saldo menor a la cantidad no es candidata pero suma al disponible', async () => {
    const r = await coilPoolFor(txWith([coil('1', 'ROJO')], { '1': '100' }), pool, '4194');
    expect(r.candidates).toEqual([]);
    expect(r.availableKg).toBe('100.000');
  });

  it('una bobina reservada por otro documento no está libre', async () => {
    mockReserved.mockResolvedValue(new Map([['1', new Prisma.Decimal('50')]]));
    const r = await coilPoolFor(txWith([coil('1', 'ROJO')], { '1': '4194' }), pool, '4194');
    expect(r.candidates).toEqual([]);
    expect(r.availableKg).toBe('0.000');
  });

  it('una bobina montada en una OP no está libre', async () => {
    mockMounted.mockResolvedValue([{ coilId: '1' }]);
    const r = await coilPoolFor(txWith([coil('1', 'ROJO')], { '1': '4194' }), pool, '4194');
    expect(r.candidates).toEqual([]);
  });

  it('una bobina atada a otra cotización abierta no está libre, y dice a cuál', async () => {
    const r = await coilPoolFor(txWith([coil('1', 'ROJO')], { '1': '4194' }, ['1']), pool, '4194');
    expect(r.candidates).toEqual([]);
    // Pendiente de UI de la ventana RF-S4b: el selector explica por qué no la ofrece.
    expect(r.taken).toEqual([{ code: expect.any(String), by: 'atada a COT-000002' }]);
  });

  // SM-P1-1 (aclaración de RF-S3c): a un VENDEDOR no se le nombra la cotización de otro vendedor.
  it.each([
    ['otro vendedor', { id: 'v-2', role: Role.VENDEDOR }, 'v-1', 'no disponible'],
    ['cotización sin dueño', { id: 'v-2', role: Role.VENDEDOR }, null, 'no disponible'],
    ['la suya', { id: 'v-1', role: Role.VENDEDOR }, 'v-1', 'atada a COT-000002'],
    ['ADMINISTRADOR', { id: 'a-1', role: Role.ADMINISTRADOR }, 'v-1', 'atada a COT-000002'],
    ['sin lector (herramienta)', undefined, 'v-1', 'atada a COT-000002'],
  ])('atada a una cotización, leída por %s', async (_label, viewer, sellerId, by) => {
    const r = await coilPoolFor(
      txWith([coil('1', 'ROJO')], { '1': '4194' }, ['1'], sellerId),
      pool,
      '4194',
      {},
      viewer,
    );
    expect(r.taken).toEqual([{ code: 'B-1', by }]);
  });

  it('la propia cotización se excluye de la búsqueda de cotizaciones tomadas', async () => {
    const tx = txWith([coil('1', 'ROJO')], { '1': '4194' });
    await coilPoolFor(tx, pool, '4194', { exceptQuotationIds: ['q-1'] });
    const calls = (tx.quotationItem.findMany as jest.Mock).mock.calls as [
      { where: { quotation: { id: { notIn: string[] } } } },
    ][];
    expect(calls[0]?.[0].where.quotation.id).toEqual({ notIn: ['q-1'] });
  });

  it('sin bobinas en el pool devuelve vacío', async () => {
    const r = await coilPoolFor(txWith([coil('9', 'AZUL')], { '9': '10' }), pool, '4194');
    expect(r).toEqual({ availableKg: '0.000', candidates: [], autoCoilId: null, taken: [] });
  });

  it('pide solo bobinas abiertas del espesor exacto', async () => {
    const tx = txWith([], {});
    await coilPoolFor(tx, pool, '1');
    const calls = (tx.coil.findMany as jest.Mock).mock.calls as [
      { where: { status: CoilStatus; thicknessMm: string } },
    ][];
    expect(calls[0]?.[0].where).toMatchObject({ status: CoilStatus.OPEN, thicknessMm: '0.38' });
  });
});
