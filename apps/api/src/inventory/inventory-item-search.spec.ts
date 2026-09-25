import { NotFoundException } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env';

// D-290: buscador de ítems del kardex (bobinas + productos, incluidos los inactivos).
function build() {
  const prisma = {
    coil: { findMany: jest.fn(), findUnique: jest.fn() },
    product: { findMany: jest.fn(), findUnique: jest.fn() },
  };
  const service = new InventoryService(prisma as unknown as PrismaService, {} as Env);
  return { prisma, service };
}

const coil = (code: string, status = 'OPEN') => ({
  id: `c-${code}`,
  code,
  typeKey: 'ALZ-0.38',
  status,
});
const product = (sku: string, name: string, isActive = true) => ({
  id: `p-${sku}`,
  sku,
  name,
  isActive,
});

describe('InventoryService.searchItems', () => {
  it('busca en bobinas por código y en productos por SKU o nombre, sin excluir inactivos', async () => {
    const { prisma, service } = build();
    prisma.coil.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([]);
    await service.searchItems('bob');
    expect(prisma.coil.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: { contains: 'bob', mode: 'insensitive' } } }),
    );
    const productWhere = (prisma.product.findMany.mock.calls[0] as [{ where: object }])[0].where;
    expect(productWhere).toEqual({
      OR: [
        { sku: { contains: 'bob', mode: 'insensitive' } },
        { name: { contains: 'bob', mode: 'insensitive' } },
      ],
    });
    // Sin `isActive`: un producto dado de baja sigue teniendo kardex.
    expect(productWhere).not.toHaveProperty('isActive');
  });

  it('marca inactivos y devuelve el tipo de cada ítem', async () => {
    const { prisma, service } = build();
    prisma.coil.findMany.mockResolvedValue([coil('C-1'), coil('C-2', 'CANCELLED')]);
    prisma.product.findMany.mockResolvedValue([product('BOB038', 'Bobina 0.38', false)]);
    const out = await service.searchItems('');
    expect(out.map((o) => [o.itemType, o.code, o.inactive])).toEqual([
      ['COIL', 'C-1', false],
      ['COIL', 'C-2', true],
      ['PRODUCT', 'BOB038', true],
    ]);
  });

  it('tope total de 20: si un tipo no llena su mitad, el otro usa el resto', async () => {
    const { prisma, service } = build();
    prisma.coil.findMany.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => coil(`C-${String(i).padStart(2, '0')}`)),
    );
    prisma.product.findMany.mockResolvedValue([product('A', 'a'), product('B', 'b')]);
    const out = await service.searchItems('');
    expect(out).toHaveLength(20);
    expect(out.filter((o) => o.itemType === 'PRODUCT')).toHaveLength(2);
    expect(out.filter((o) => o.itemType === 'COIL')).toHaveLength(18);
  });
});

describe('InventoryService.resolveItem', () => {
  it('rotula un producto inactivo', async () => {
    const { prisma, service } = build();
    prisma.product.findUnique.mockResolvedValue(product('P-1', 'Plancha', false));
    await expect(service.resolveItem({ itemType: 'PRODUCT', itemId: 'p-P-1' })).resolves.toEqual({
      itemType: 'PRODUCT',
      itemId: 'p-P-1',
      code: 'P-1',
      description: 'Plancha',
      inactive: true,
    });
  });

  it('404 si el ítem no existe', async () => {
    const { prisma, service } = build();
    prisma.coil.findUnique.mockResolvedValue(null);
    await expect(service.resolveItem({ itemType: 'COIL', itemId: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
