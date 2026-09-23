import { Test } from '@nestjs/testing';
import { BusinessLineCode, ProductSource } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ColorsService } from '../colors/colors.service';
import { PrismaService } from '../prisma/prisma.service';
import { openCoilCodesInPool } from '../sales/coil-sale-product';
import { CatalogService } from './catalog.service';

jest.mock('../sales/coil-sale-product', () => ({
  ...jest.requireActual<object>('../sales/coil-sale-product'),
  openCoilCodesInPool: jest.fn(),
}));

/**
 * RF-S4b — los guards del catálogo sobre los productos de venta de bobina:
 * - D-257: el SKU `BOB…` se genera al dar de alta la bobina, no se crea a mano;
 * - D-257 (aclaración): no se desactiva con bobinas abiertas con saldo en su pool;
 * - D-253: un producto unido a otro no se reactiva.
 */

const ACTOR = { id: 'u-1' } as never;
const STOP = new Error('llegó a la transacción');

function product(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'p-1',
    businessLineId: 'bl-t',
    businessLine: { code: BusinessLineCode.TRADING },
    sku: 'BOB038ROJO',
    name: 'Bobina Rojo 0.38 mm',
    unit: 'KGM',
    listPricePen: null,
    colorId: null,
    color: null,
    finishId: null,
    finish: null,
    thicknessMm: null,
    widthMm: null,
    lengthMm: null,
    pieceWeightKg: null,
    roofingKind: null,
    isActive: true,
    mergedIntoId: null,
    source: ProductSource.PURCHASED,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

describe('CatalogService — guards de los productos de venta de bobina', () => {
  let service: CatalogService;
  const prisma = {
    businessLine: { findUnique: jest.fn() },
    product: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.businessLine.findUnique.mockResolvedValue({
      id: 'bl-t',
      code: BusinessLineCode.TRADING,
    });
    prisma.$transaction.mockRejectedValue(STOP);
    const moduleRef = await Test.createTestingModule({
      providers: [
        CatalogService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { write: jest.fn() } },
        { provide: ColorsService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(CatalogService);
  });

  it('no da de alta un SKU BOB… a mano, en ninguna caja', async () => {
    await expect(
      service.create(ACTOR, {
        businessLineId: 'bl-t',
        sku: 'bob040rojo',
        name: 'x',
        unit: 'KGM',
        source: ProductSource.PURCHASED,
      } as never),
    ).rejects.toThrow(/se generan solos al dar de alta la bobina/);
  });

  it('no desactiva el producto de venta con bobinas abiertas con saldo, y nombra hasta tres', async () => {
    prisma.product.findUnique.mockResolvedValue(product());
    (openCoilCodesInPool as jest.Mock).mockResolvedValue(['B-1', 'B-2', 'B-3', 'B-4']);
    await expect(service.update(ACTOR, 'p-1', { isActive: false })).rejects.toThrow(
      /4 bobina\(s\) abierta\(s\) con saldo \(B-1, B-2, B-3…\)/,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('con una sola bobina abierta la nombra sin puntos suspensivos', async () => {
    prisma.product.findUnique.mockResolvedValue(product());
    (openCoilCodesInPool as jest.Mock).mockResolvedValue(['B-1']);
    await expect(service.update(ACTOR, 'p-1', { isActive: false })).rejects.toThrow(
      /1 bobina\(s\) abierta\(s\) con saldo \(B-1\):/,
    );
  });

  it('sin bobinas abiertas en el pool, sí se puede desactivar', async () => {
    prisma.product.findUnique.mockResolvedValue(product());
    (openCoilCodesInPool as jest.Mock).mockResolvedValue([]);
    await expect(service.update(ACTOR, 'p-1', { isActive: false })).rejects.toBe(STOP);
    expect(openCoilCodesInPool).toHaveBeenCalledTimes(1);
  });

  it('un producto que no es de bobina ni consulta el pool', async () => {
    prisma.product.findUnique.mockResolvedValue(product({ sku: 'COB040ROJO' }));
    await expect(service.update(ACTOR, 'p-1', { isActive: false })).rejects.toBe(STOP);
    expect(openCoilCodesInPool).not.toHaveBeenCalled();
  });

  it('un producto ya inactivo no vuelve a consultar el pool', async () => {
    prisma.product.findUnique.mockResolvedValue(product({ isActive: false }));
    await expect(service.update(ACTOR, 'p-1', { isActive: false })).rejects.toBe(STOP);
    expect(openCoilCodesInPool).not.toHaveBeenCalled();
  });

  it('un producto unido a otro no se reactiva: 400 y no el 500 del CHECK', async () => {
    prisma.product.findUnique.mockResolvedValue(
      product({ isActive: false, mergedIntoId: 'p-main' }),
    );
    await expect(service.update(ACTOR, 'p-1', { isActive: true })).rejects.toThrow(
      /está unido a otro producto/,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
