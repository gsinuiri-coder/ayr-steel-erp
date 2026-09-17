import { Test } from '@nestjs/testing';
import { BusinessLineCode, ProductSource } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ColorsService } from '../colors/colors.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogService } from './catalog.service';

function product(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'p-1',
    businessLineId: 'bl-1',
    businessLine: { code: BusinessLineCode.TRADING },
    sku: 'PLA-001',
    name: 'Plancha lisa',
    unit: 'UND',
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
    source: ProductSource.MANUFACTURED,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('CatalogService.search (RF-S3/M1)', () => {
  let service: CatalogService;
  const prisma = { product: { findMany: jest.fn() } };
  const audit = { write: jest.fn() };
  const colors = {};

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CatalogService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: ColorsService, useValue: colors },
      ],
    }).compile();
    service = moduleRef.get(CatalogService);
  });

  it('solo busca entre activos, por SKU o nombre', async () => {
    prisma.product.findMany.mockResolvedValue([]);
    await service.search('pla');
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          OR: [
            { sku: { contains: 'pla', mode: 'insensitive' } },
            { name: { contains: 'pla', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });

  it('filtra por línea de negocio cuando se pasa (traduce el código compartido al de Prisma)', async () => {
    prisma.product.findMany.mockResolvedValue([]);
    await service.search('pla', 'metallic-roofing');
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          businessLine: { code: BusinessLineCode.METALLIC_ROOFING },
        }),
      }),
    );
  });

  it('el prefijo de SKU va antes que un nombre que solo contiene el texto', async () => {
    const contains = product({ id: 'p-contains', sku: 'ZZZ-001', name: 'Cobertura BOB38' });
    const prefix = product({ id: 'p-prefix', sku: 'BOB38AZUL', name: 'Bobina azul' });
    prisma.product.findMany.mockResolvedValue([contains, prefix]);

    const result = await service.search('BOB38');

    expect(result.map((p) => p.id)).toEqual(['p-prefix', 'p-contains']);
  });

  it('recorta a SEARCH_RESULT_LIMIT (20) aunque SQL haya devuelto más candidatos', async () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      product({ id: `p-${String(i)}`, sku: `SKU-${String(i)}` }),
    );
    prisma.product.findMany.mockResolvedValue(rows);

    const result = await service.search('sku');

    expect(result).toHaveLength(20);
  });
});
