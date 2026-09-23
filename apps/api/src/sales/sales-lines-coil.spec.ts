import { CoilKind, CoilStatus, FinishKind, InventoryStrategy, Prisma } from '@prisma/client';
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
}
function txWith(o: Opts = {}) {
  const coil = {
    id: COIL_ID,
    code: 'SALDO-AZUL-4194',
    kind: o.kind ?? CoilKind.COIL,
    status: o.status ?? CoilStatus.OPEN,
    thicknessMm: D('0.38'),
    finish: { code: 'ALZ-AZUL-5002', kind: FinishKind.PREPINTADO, color: { code: 'AZUL' } },
  };
  return {
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
