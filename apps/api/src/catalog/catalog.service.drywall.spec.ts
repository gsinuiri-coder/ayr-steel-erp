import { Test } from '@nestjs/testing';
import { BusinessLineCode, ProductSource } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import { ColorsService } from '../colors/colors.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogService } from './catalog.service';

/**
 * D-344 — el SKU de un perfil de drywall: el espesor y el ancho son del **fleje**, ambos
 * obligatorios; no lleva acabado (es siempre galvanizado); y el catálogo avisa cuando el kg/pieza
 * declarado se aleja más del 5 % del teórico.
 */

const ACTOR = { id: 'u-1' } as never;
const STOP = new Error('llegó a la transacción');
const BL = 'bl-drywall';

const baseInput = {
  businessLineId: BL,
  sku: 'OMEGA045',
  name: 'OMEGA',
  unit: 'NIU',
  source: ProductSource.MANUFACTURED,
  finishId: null,
  colorId: null,
  thicknessMm: '0.45',
  widthMm: '115.00',
  lengthMm: '3000.00',
  pieceWeightKg: '1.220',
  roofingKind: null,
  listPricePen: null,
};

function stored(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'p-1',
    businessLineId: BL,
    businessLine: { code: BusinessLineCode.DRYWALL },
    sku: 'OMEGA045',
    name: 'OMEGA',
    unit: 'NIU',
    listPricePen: null,
    colorId: null,
    color: null,
    finishId: null,
    finish: null,
    thicknessMm: new Decimal('0.45'),
    widthMm: new Decimal('115.00'),
    lengthMm: new Decimal('3000.00'),
    pieceWeightKg: new Decimal('1.220'),
    roofingKind: null,
    isActive: true,
    mergedIntoId: null,
    source: ProductSource.MANUFACTURED,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

describe('CatalogService — el SKU de drywall (D-344)', () => {
  let service: CatalogService;
  const prisma = {
    businessLine: { findUnique: jest.fn() },
    finish: { findUnique: jest.fn(), findFirst: jest.fn() },
    product: { findUnique: jest.fn(), findMany: jest.fn() },
    productionOrder: { count: jest.fn() },
    $transaction: jest.fn(),
  };
  const colors = { resolveActive: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.businessLine.findUnique.mockResolvedValue({ id: BL, code: BusinessLineCode.DRYWALL });
    prisma.finish.findUnique.mockResolvedValue(null);
    // Acabado galvanizado activo: de él sale la densidad del aviso de kg/pieza.
    prisma.finish.findFirst.mockResolvedValue({ densityFactor: new Decimal('7.8500') });
    prisma.productionOrder.count.mockResolvedValue(0);
    colors.resolveActive.mockResolvedValue(null);
    prisma.$transaction.mockRejectedValue(STOP);
    const moduleRef = await Test.createTestingModule({
      providers: [
        CatalogService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { write: jest.fn() } },
        { provide: ColorsService, useValue: colors },
      ],
    }).compile();
    service = moduleRef.get(CatalogService);
  });

  describe('alta', () => {
    it('con espesor y ancho del fleje, largo y peso, pasa las validaciones y llega a la transacción', async () => {
      await expect(service.create(ACTOR, baseInput as never)).rejects.toBe(STOP);
    });

    it.each([
      ['espesor', { thicknessMm: null }, /El espesor del fleje es obligatorio en Drywall/],
      ['ancho', { widthMm: null }, /El ancho del fleje \(desarrollo\) es obligatorio en Drywall/],
      ['largo', { lengthMm: null }, /El largo de la pieza terminada es obligatorio en Drywall/],
      ['peso', { pieceWeightKg: null }, /El peso de la pieza terminada es obligatorio en Drywall/],
    ])('sin %s se rechaza y no llega a la transacción', async (_n, over, msg) => {
      await expect(service.create(ACTOR, { ...baseInput, ...over })).rejects.toThrow(msg);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('drywall no lleva acabado en el SKU: siempre es galvanizado', async () => {
      await expect(service.create(ACTOR, { ...baseInput, finishId: 'fin-galv' })).rejects.toThrow(
        /Drywall no lleva acabado en el SKU/,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('edición', () => {
    it('quitar el espesor de un perfil se rechaza: vuelve a comprobar la forma entera', async () => {
      prisma.product.findUnique.mockResolvedValue(stored());
      await expect(service.update(ACTOR, 'p-1', { thicknessMm: null })).rejects.toThrow(
        /El espesor del fleje es obligatorio en Drywall/,
      );
    });

    it('cargar el espesor de un perfil que no lo tenía (el caso de los 10 de producción) pasa', async () => {
      prisma.product.findUnique.mockResolvedValue(stored({ thicknessMm: null }));
      await expect(service.update(ACTOR, 'p-1', { thicknessMm: '0.45' })).rejects.toBe(STOP);
    });

    it('un cambio que no toca los campos del fleje (el precio, activar) no exige completar el catálogo viejo', async () => {
      prisma.product.findUnique.mockResolvedValue(stored({ thicknessMm: null }));
      await expect(service.update(ACTOR, 'p-1', { isActive: false })).rejects.toBe(STOP);
    });

    it('mandar un acabado a un perfil de drywall se rechaza', async () => {
      prisma.product.findUnique.mockResolvedValue(stored());
      await expect(service.update(ACTOR, 'p-1', { finishId: 'fin-galv' })).rejects.toThrow(
        /Drywall no lleva acabado en el SKU/,
      );
    });

    it('quitar el acabado (null) sí se acepta: es lo que el catálogo nuevo manda siempre', async () => {
      prisma.product.findUnique.mockResolvedValue(stored());
      await expect(
        service.update(ACTOR, 'p-1', { finishId: null, widthMm: '116.00' }),
      ).rejects.toBe(STOP);
    });

    it('cambiar la unidad u origen ya no lo frena una receta (no existen)', async () => {
      prisma.product.findUnique.mockResolvedValue(stored());
      await expect(service.update(ACTOR, 'p-1', { unit: 'UND' })).rejects.toBe(STOP);
    });
  });

  describe('con una orden de producción en curso (antes: «la receta se bloquea»)', () => {
    beforeEach(() => {
      prisma.product.findUnique.mockResolvedValue(stored());
      prisma.productionOrder.count.mockResolvedValue(2);
    });

    it.each([
      ['el espesor del fleje', { thicknessMm: '0.60' }],
      ['el ancho del fleje', { widthMm: '120.00' }],
      ['la unidad', { unit: 'UND' }],
      ['el origen', { source: ProductSource.PURCHASED }],
    ])(
      'no se cambia %s: sus flejes ya se montaron contra el valor de antes',
      async (_n, change) => {
        await expect(service.update(ACTOR, 'p-1', change as never)).rejects.toThrow(
          /tiene 2 orden\(es\) de producción en curso: ciérralas o anúlalas antes de cambiar la unidad, el origen, el espesor o el ancho del fleje/,
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('lo que no decide el fleje sí se edita: el peso, el largo, el nombre y el mismo espesor con otro formato', async () => {
      await expect(service.update(ACTOR, 'p-1', { pieceWeightKg: '1.300' })).rejects.toBe(STOP);
      await expect(service.update(ACTOR, 'p-1', { name: 'OMEGA 2' })).rejects.toBe(STOP);
      // «0.4500» es el mismo espesor que 0.45: no es un cambio.
      await expect(service.update(ACTOR, 'p-1', { thicknessMm: '0.4500' })).rejects.toBe(STOP);
    });

    it('sin órdenes en curso, cambiar el espesor pasa', async () => {
      prisma.productionOrder.count.mockResolvedValue(0);
      await expect(service.update(ACTOR, 'p-1', { thicknessMm: '0.60' })).rejects.toBe(STOP);
    });

    it('quitar el espesor (o el ancho) también es un cambio y también se frena', async () => {
      prisma.product.findUnique.mockResolvedValue(stored({ thicknessMm: null }));
      await expect(service.update(ACTOR, 'p-1', { thicknessMm: '0.45' })).rejects.toThrow(
        /en curso/,
      );
    });
  });

  describe('aviso del kg/pieza contra el teórico', () => {
    const check = async (row: ReturnType<typeof stored>) => {
      prisma.product.findUnique.mockResolvedValue(row);
      return (await service.findOne('p-1')).pieceWeightCheck;
    };

    it('OMEGA045 con datos reales: teórico 1.231 kg, sin aviso', async () => {
      const r = await check(stored());
      expect(r?.theoreticalKg).toBe('1.231');
      expect(r?.warn).toBe(false);
    });

    it('un marcador (ancho 1.00, kg 1.000) avisa', async () => {
      const r = await check(
        stored({
          widthMm: new Decimal('1.00'),
          pieceWeightKg: new Decimal('1.000'),
          lengthMm: new Decimal('6000.00'),
        }),
      );
      expect(r?.warn).toBe(true);
    });

    it('sin espesor no hay comparación', async () => {
      expect(await check(stored({ thicknessMm: null }))).toBeNull();
    });

    it('sin un acabado galvanizado activo del que sacar la densidad no hay comparación', async () => {
      prisma.finish.findFirst.mockResolvedValue(null);
      expect(await check(stored())).toBeNull();
    });

    it('un producto que no es un perfil de drywall no lleva el aviso', async () => {
      expect(await check(stored({ businessLine: { code: BusinessLineCode.TRADING } }))).toBeNull();
      expect(await check(stored({ source: ProductSource.PURCHASED }))).toBeNull();
    });

    it('el catálogo entero calcula la densidad una sola vez, no una por producto', async () => {
      prisma.product.findMany.mockResolvedValue([stored(), stored({ id: 'p-2', sku: 'P38' })]);
      const list = await service.findAll();
      expect(list).toHaveLength(2);
      expect(prisma.finish.findFirst).toHaveBeenCalledTimes(1);
    });
  });
});
