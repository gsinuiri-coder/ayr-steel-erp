import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BusinessLineCode } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ColorsService } from '../colors/colors.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogService } from './catalog.service';
import * as productUsage from './product-usage';

/**
 * D-347/M6 — `DELETE /catalog/:id`: borrado físico de un producto que **nunca se usó**.
 * `describeProductUsage` ya tiene su propia batería de tests (`product-usage.spec.ts`); acá
 * solo se prueba que el servicio lo respeta, bloquea la fila y audita sin `after` (el producto
 * ya no existe después de esta acción).
 */

const ACTOR = { id: 'admin-1' } as never;
const PRODUCT = {
  id: 'p-1',
  sku: 'PERFIL01',
  name: 'Perfil sin uso',
  businessLine: { code: BusinessLineCode.DRYWALL },
};

describe('CatalogService.remove', () => {
  let service: CatalogService;
  // El mismo objeto entra como `tx` dentro de `$transaction` — `catalog.service.ts` usa
  // `this.prisma.$transaction(async (tx) => ...)`, y acá `tx === prisma` a propósito, para no
  // duplicar cada mock de tabla que `describeProductUsage` (mockeado aparte) ya no necesita.
  const prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    product: { findUnique: jest.Mock; delete: jest.Mock };
  } = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([]),
    product: {
      findUnique: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const audits: Record<string, unknown>[] = [];
  const audit = {
    write: jest.fn((_tx: unknown, entry: Record<string, unknown>) => {
      audits.push(entry);
      return Promise.resolve();
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    audits.length = 0;
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
    prisma.product.findUnique.mockResolvedValue(PRODUCT);
    const moduleRef = await Test.createTestingModule({
      providers: [
        CatalogService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: ColorsService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(CatalogService);
  });

  it('404 si el producto no existe', async () => {
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(service.remove(ACTOR, 'no-existe')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.product.delete).not.toHaveBeenCalled();
  });

  it('409 si está en uso: no borra ni audita', async () => {
    jest
      .spyOn(productUsage, 'describeProductUsage')
      .mockResolvedValue(['3 movimiento(s) de kardex']);
    await expect(service.remove(ACTOR, PRODUCT.id)).rejects.toThrow(
      /no se puede borrar: está en uso \(3 movimiento\(s\) de kardex\)/,
    );
    await expect(service.remove(ACTOR, PRODUCT.id)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.product.delete).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it('nunca se usó: bloquea la fila, borra y audita sin after', async () => {
    jest.spyOn(productUsage, 'describeProductUsage').mockResolvedValue([]);
    await service.remove(ACTOR, PRODUCT.id);
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.product.delete).toHaveBeenCalledWith({ where: { id: PRODUCT.id } });
    expect(audits).toEqual([
      expect.objectContaining({
        actorId: 'admin-1',
        action: 'catalog.product-delete',
        entity: 'products',
        entityId: PRODUCT.id,
        before: { sku: PRODUCT.sku, name: PRODUCT.name },
      }),
    ]);
    expect(audits[0]).not.toHaveProperty('after');
  });
});
