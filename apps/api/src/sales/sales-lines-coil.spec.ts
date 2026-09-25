import { CoilKind, CoilStatus, FinishKind, InventoryStrategy, Prisma, Role } from '@prisma/client';
import { IMPORT_ROUNDING_TOLERANCE_PEN } from '@ayr/shared';
import { resolveSalesLines } from './sales-lines';

/**
 * D-254/D-255 dentro de `resolveSalesLines`, con una base falsa: una línea del papel vende **la
 * cantidad del papel** sobre una bobina libre; el alta a mano vende el saldo completo (D-116) y
 * no reinterpreta un importe fijo si el saldo cambió; y un producto `BOB…` no se vende como
 * línea de catálogo.
 */

const mockMounted = jest.fn().mockResolvedValue([]);
jest.mock('../production/production-assignments', () => ({
  findLiveStripAssignments: (...a: unknown[]) => mockMounted(...a) as unknown,
}));
jest.mock('./reserved-ledger', () => ({
  reservedByItem: jest.fn().mockResolvedValue(new Map()),
}));
const mockFloor = jest.fn().mockResolvedValue(undefined);
jest.mock('./price-floor', () => ({
  assertPriceFloor: (...a: unknown[]) => mockFloor(...a) as unknown,
}));

const D = (v: string) => new Prisma.Decimal(v);
const COIL_ID = '11111111-1111-4111-8111-111111111111';
const PAPER = { tolerancePen: IMPORT_ROUNDING_TOLERANCE_PEN, documentLabel: 'FFA1-1350' };

interface Opts {
  status?: CoilStatus;
  balance?: string;
  kind?: CoilKind;
  hasCoil?: boolean;
  hasProduct?: boolean;
  catalogSku?: string;
  /** D-254: la bobina ya la vende otra cotización abierta. */
  quoted?: boolean;
}
function txWith(o: Opts = {}) {
  const coil = {
    id: COIL_ID,
    code: 'SALDO-AZUL-4194',
    kind: o.kind ?? CoilKind.COIL,
    status: o.status ?? CoilStatus.OPEN,
    thicknessMm: D('0.38'),
    widthMm: D('1200'),
    finish: { code: 'ALZ-AZUL-5002', kind: FinishKind.PREPINTADO, color: { code: 'AZUL' } },
  };
  return {
    color: { findMany: jest.fn().mockResolvedValue([{ code: 'AZUL' }, { code: 'ROJO' }]) },
    quotationItem: {
      findMany: jest
        .fn()
        .mockResolvedValue(o.quoted ? [{ reserveItemId: COIL_ID, quotation: { seq: 2 } }] : []),
    },
    coil: { findMany: jest.fn().mockResolvedValue(o.hasCoil === false ? [] : [coil]) },
    businessLine: { findUnique: jest.fn().mockResolvedValue({ id: 'bl-t' }) },
    product: {
      findMany: jest.fn(({ where }: { where: { businessLineId?: string } }) => {
        if (where.businessLineId !== undefined) {
          return Promise.resolve(
            o.hasProduct === false
              ? []
              : [{ id: 'p-canon', sku: 'BOB038AZUL', name: 'Bobina Azul', businessLineId: 'bl-t' }],
          );
        }
        // Las líneas de catálogo: un `BOB…` suelto de la línea de reventa, o un producto común.
        return Promise.resolve([
          {
            id: '22222222-2222-4222-8222-222222222222',
            sku: o.catalogSku ?? 'BOB38AZUL',
            name: 'Producto',
            unit: 'KGM',
            isActive: true,
            businessLineId: 'bl-t',
            listPricePen: null,
            roofingKind: null,
            lengthMm: null,
            thicknessMm: null,
            widthMm: null,
            colorId: null,
            color: null,
            finish: null,
            businessLine: {
              inventoryStrategy: InventoryStrategy.STOCK,
              code: (o.catalogSku ?? 'BOB38AZUL').startsWith('BOB') ? 'TRADING' : 'ROOFING',
            },
          },
        ]);
      }),
    },
    inventoryBalance: {
      findMany: jest.fn().mockResolvedValue([{ itemId: COIL_ID, qty: D(o.balance ?? '4194') }]),
    },
  } as unknown as Prisma.TransactionClient;
}

beforeEach(() => mockMounted.mockResolvedValue([]));

describe('venta de bobina con la cantidad del papel (importador)', () => {
  const item = {
    saleCoilId: COIL_ID,
    // El importador manda el producto de bobina de la fila: la bobina tiene que ser de su pool.
    productId: '22222222-2222-4222-8222-222222222222',
    qty: '4000.000',
    netAmountPen: '12000.0000',
    igvAmountPen: '2160.0000',
    totalAmountPen: '14160.0000',
  };

  it('vende la cantidad del papel, no el saldo, con los tres importes', async () => {
    const [line] = await resolveSalesLines(txWith(), [item], { exactAmounts: PAPER });
    expect(line).toMatchObject({
      qty: '4000.000',
      reserveQty: '4000.000',
      reserveItemId: COIL_ID,
      productId: 'p-canon',
      subtotalPen: '12000.0000',
      igvPen: '2160.0000',
      totalPen: '14160.0000',
      unitPricePen: '3.0000',
    });
  });

  it('rechaza una cantidad mayor al saldo de la bobina', async () => {
    await expect(
      resolveSalesLines(txWith({ balance: '3000' }), [item], { exactAmounts: PAPER }),
    ).rejects.toThrow(/tiene 3000\.000 kg disponibles/);
  });

  it('rechaza una bobina que ya no está abierta', async () => {
    await expect(
      resolveSalesLines(txWith({ status: CoilStatus.CLOSED }), [item], { exactAmounts: PAPER }),
    ).rejects.toThrow(/ya no está libre para venderse \(CLOSED\)/);
  });

  it('rechaza una bobina montada en una OP', async () => {
    mockMounted.mockResolvedValue([{ coilId: COIL_ID }]);
    await expect(resolveSalesLines(txWith(), [item], { exactAmounts: PAPER })).rejects.toThrow(
      /montada en una OP/,
    );
  });
});

describe('venta de bobina a mano (D-116)', () => {
  it('con precio por kg vende el saldo completo', async () => {
    const [line] = await resolveSalesLines(txWith({ balance: '900' }), [
      { saleCoilId: COIL_ID, qty: '1.000', unitPricePen: '4.0000' },
    ]);
    expect(line).toMatchObject({ qty: '900.000', subtotalPen: '3600.0000' });
  });

  it('un importe fijo sobre una cantidad que ya no es el saldo se rechaza, no se reinterpreta', async () => {
    await expect(
      resolveSalesLines(txWith({ balance: '900' }), [
        { saleCoilId: COIL_ID, qty: '1000.000', netAmountPen: '4000.0000' },
      ]),
    ).rejects.toThrow(/el saldo de SALDO-AZUL-4194 cambió/);
  });

  it('un precio con IGV sobre el saldo vigente se acepta', async () => {
    const [line] = await resolveSalesLines(txWith({ balance: '1000' }), [
      { saleCoilId: COIL_ID, qty: '1000.000', unitPriceWithIgvPen: '4.7200' },
    ]);
    expect(line?.totalPen).toBe('4720.0000');
  });

  it('sin ninguna forma de precio pide el precio por kg', async () => {
    await expect(
      resolveSalesLines(txWith(), [{ saleCoilId: COIL_ID, qty: '1.000' }]),
    ).rejects.toThrow(/escribe el precio por kg/);
  });

  it('una bobina que no existe se reporta', async () => {
    await expect(
      resolveSalesLines(txWith({ hasCoil: false }), [
        { saleCoilId: COIL_ID, qty: '1.000', unitPricePen: '4.0000' },
      ]),
    ).rejects.toThrow(/bobina a vender no encontrada/);
  });

  it('un fleje no se vende como bobina', async () => {
    await expect(
      resolveSalesLines(txWith({ kind: CoilKind.STRIP }), [
        { saleCoilId: COIL_ID, qty: '1.000', unitPricePen: '4.0000' },
      ]),
    ).rejects.toThrow(/no un fleje/);
  });

  it('sin producto de venta de esa bobina, se dice cuál falta', async () => {
    await expect(
      resolveSalesLines(txWith({ hasProduct: false }), [
        { saleCoilId: COIL_ID, qty: '1.000', unitPricePen: '4.0000' },
      ]),
    ).rejects.toThrow(/no existe el producto de venta directa \(BOB038AZUL\)/);
  });
});

describe('un producto BOB… no se vende como línea de catálogo', () => {
  it('rebota nombrando el motivo', async () => {
    await expect(
      resolveSalesLines(txWith(), [
        {
          productId: '22222222-2222-4222-8222-222222222222',
          qty: '10.000',
          unitPricePen: '3.0000',
        },
      ]),
    ).rejects.toThrow(/es el producto de venta de una bobina/);
  });

  it('un producto común de la misma línea sí se vende', async () => {
    const [line] = await resolveSalesLines(txWith({ catalogSku: 'ACC-001' }), [
      { productId: '22222222-2222-4222-8222-222222222222', qty: '10.000', unitPricePen: '3.0000' },
    ]);
    expect(line?.subtotalPen).toBe('30.0000');
  });
});

describe('D-254 en el servidor: la bobina de una línea del papel es candidata de su pool (P2-1)', () => {
  const paperItem = (over: Record<string, unknown> = {}) => ({
    saleCoilId: COIL_ID,
    productId: '22222222-2222-4222-8222-222222222222',
    qty: '1000.000',
    netAmountPen: '3000.0000',
    ...over,
  });

  it('importador: una bobina de otro espesor o color que el producto de la fila se rechaza', async () => {
    await expect(
      resolveSalesLines(txWith({ catalogSku: 'BOB45ROJO' }), [paperItem()], {
        exactAmounts: PAPER,
      }),
    ).rejects.toThrow(/es del pool BOB038AZUL y la línea es de BOB045ROJO/);
  });

  it('importador: una bobina que ya vende otra cotización abierta no es candidata', async () => {
    await expect(
      resolveSalesLines(txWith({ quoted: true }), [paperItem()], { exactAmounts: PAPER }),
    ).rejects.toThrow(/no es candidata del pool BOB038AZUL/);
  });

  it('importador: una bobina montada en una OP no es candidata', async () => {
    mockMounted.mockResolvedValue([{ coilId: COIL_ID }]);
    await expect(
      resolveSalesLines(txWith(), [paperItem()], { exactAmounts: PAPER }),
    ).rejects.toThrow(/montada en una OP|no es candidata/);
  });

  it('importador: una bobina libre del pool, con saldo, pasa', async () => {
    const [line] = await resolveSalesLines(txWith(), [paperItem()], { exactAmounts: PAPER });
    expect(line).toMatchObject({ qty: '1000.000', reserveItemId: COIL_ID });
  });

  it('edición de cotización: sin producto en la línea, la bobina tiene que ser de un pool del documento', async () => {
    const { productId: _p, ...noProduct } = paperItem();
    await expect(
      resolveSalesLines(txWith(), [noProduct], {
        exactAmounts: PAPER,
        coilPool: { allowedPools: new Set(['BOB045ROJO']) },
      }),
    ).rejects.toThrow(/que no es el de ninguna línea de este documento \(BOB045ROJO\)/);
    const [line] = await resolveSalesLines(txWith(), [noProduct], {
      exactAmounts: PAPER,
      coilPool: { allowedPools: new Set(['BOB038AZUL']) },
    });
    expect(line?.reserveItemId).toBe(COIL_ID);
  });

  it('edición de cotización: una bobina que ya vende otra cotización abierta no es candidata', async () => {
    const { productId: _p, ...noProduct } = paperItem();
    await expect(
      resolveSalesLines(txWith({ quoted: true }), [noProduct], {
        exactAmounts: PAPER,
        coilPool: { allowedPools: new Set(['BOB038AZUL']), scope: { exceptQuotationIds: ['q-1'] } },
      }),
    ).rejects.toThrow(/no es candidata del pool BOB038AZUL/);
  });

  it('edición de cotización: la bobina que el documento ya vendía no compite consigo misma', async () => {
    const { productId: _p, ...noProduct } = paperItem();
    const [line] = await resolveSalesLines(txWith({ quoted: true }), [noProduct], {
      exactAmounts: PAPER,
      coilPool: {
        allowedPools: new Set(['BOB038AZUL']),
        preexistingCoilIds: new Set([COIL_ID]),
      },
    });
    expect(line?.reserveItemId).toBe(COIL_ID);
  });

  it('sin producto ni pools del documento, una línea del papel no sabe de qué pool es y se rechaza', async () => {
    const { productId: _p, ...noProduct } = paperItem();
    await expect(resolveSalesLines(txWith(), [noProduct], { exactAmounts: PAPER })).rejects.toThrow(
      /tiene que decir de qué producto de bobina es/,
    );
  });
});

describe('D-310: una bobina entera atada a otra cotización abierta no se vende en el alta', () => {
  const hand = { saleCoilId: COIL_ID, qty: '1.000', unitPricePen: '3.0000' };
  const tied = (sellerId: string | null) => {
    const tx = txWith();
    (tx.quotationItem.findMany as jest.Mock).mockResolvedValue([
      { reserveItemId: COIL_ID, quotation: { seq: 2, sellerId } },
    ]);
    return tx;
  };

  it('sin la opción, la línea a mano no mira las cotizaciones (importador, ediciones de pedido)', async () => {
    const [line] = await resolveSalesLines(txWith({ quoted: true }), [hand]);
    expect(line?.reserveItemId).toBe(COIL_ID);
  });

  it('nombra la cotización que la tiene atada, con el número de la línea', async () => {
    await expect(
      resolveSalesLines(tied('v-1'), [hand], {
        coilTies: { viewer: { id: 'a-1', role: Role.ADMINISTRADOR } },
      }),
    ).rejects.toThrow(/Línea 1: la bobina SALDO-AZUL-4194 no se puede vender: atada a COT-000002/);
  });

  it('a un VENDEDOR no se le nombra la cotización de otro vendedor', async () => {
    await expect(
      resolveSalesLines(tied('v-1'), [hand], {
        coilTies: { viewer: { id: 'v-2', role: Role.VENDEDOR } },
      }),
    ).rejects.toThrow(/no se puede vender: no disponible/);
  });

  it('la cotización que se edita no compite consigo misma', async () => {
    const tx = txWith();
    await resolveSalesLines(tx, [hand], {
      coilTies: { exceptQuotationIds: ['q-1'], viewer: { id: 'a-1', role: Role.ADMINISTRADOR } },
    });
    const calls = (tx.quotationItem.findMany as jest.Mock).mock.calls as [
      { where: { quotation: { id: { notIn: string[] } } } },
    ][];
    expect(calls[0]?.[0].where.quotation.id).toEqual({ notIn: ['q-1'] });
  });

  it('una bobina libre pasa', async () => {
    const [line] = await resolveSalesLines(txWith(), [hand], { coilTies: {} });
    expect(line?.reserveItemId).toBe(COIL_ID);
  });
});

describe('D-256 (aclaración): solo las líneas que representan al comprobante conservan el papel', () => {
  beforeEach(() => mockFloor.mockClear());
  const partial = {
    saleCoilId: COIL_ID,
    productId: '22222222-2222-4222-8222-222222222222',
    qty: '1000.000',
    netAmountPen: '3000.0000',
  };

  it('una línea que no representa al comprobante no vende una parte de la bobina', async () => {
    await expect(
      resolveSalesLines(txWith(), [partial], {
        exactAmounts: PAPER,
        paperLines: new Set<number>(),
        priceFloor: { toleranceMm: '1' },
      }),
    ).rejects.toThrow(/el saldo de SALDO-AZUL-4194 cambió/);
  });

  it('la línea del papel no pasa por el piso y la que cambió sí, en el mismo documento', async () => {
    await resolveSalesLines(
      txWith(),
      [
        partial,
        { saleCoilId: COIL_ID.replace('1111', '3333'), qty: '1.000', unitPricePen: '1.0000' },
      ],
      {
        exactAmounts: PAPER,
        paperLines: new Set([0]),
        priceFloor: { toleranceMm: '1' },
      },
    ).catch(() => undefined);
    const calls = mockFloor.mock.calls as unknown[][];
    const candidates = (calls[0]?.[1] ?? []) as { at: string }[];
    expect(candidates.map((c) => c.at)).not.toContain('Línea 1');
  });

  it('sin paperLines (ADMINISTRADOR o importador), todas las líneas conservan el papel', async () => {
    const [line] = await resolveSalesLines(txWith(), [partial], { exactAmounts: PAPER });
    expect(line?.qty).toBe('1000.000');
  });
});
