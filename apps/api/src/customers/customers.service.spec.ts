import { Test } from '@nestjs/testing';
import { DocType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CustomersService } from './customers.service';

function customer(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'c-1',
    docType: DocType.RUC,
    docNumber: '20000000001',
    name: 'ACME SAC',
    address: null,
    email: null,
    phone: null,
    creditDays: 0,
    needsReview: false,
    isSystem: false,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('CustomersService.search (RF-S3/M1)', () => {
  let service: CustomersService;
  const prisma = { customer: { findMany: jest.fn() } };
  const audit = { write: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(CustomersService);
  });

  it('solo busca entre activos, por nombre o documento', async () => {
    prisma.customer.findMany.mockResolvedValue([]);
    await service.search('acm');
    expect(prisma.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          OR: [
            { name: { contains: 'acm', mode: 'insensitive' } },
            { docNumber: { contains: 'acm', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });

  it('el prefijo va antes que un "contiene" en cualquier otra posición', async () => {
    const contains = customer({ id: 'c-contains', name: 'La Metálica ACM' });
    const prefix = customer({ id: 'c-prefix', name: 'ACM Distribuidora' });
    // El orden que trae la consulta (alfabético) pone primero el que NO es prefijo —
    // si el rankeo no reordenara, esta prueba fallaría.
    prisma.customer.findMany.mockResolvedValue([contains, prefix]);

    const result = await service.search('ACM');

    expect(result.map((c) => c.id)).toEqual(['c-prefix', 'c-contains']);
  });

  it('recorta a SEARCH_RESULT_LIMIT (20) aunque SQL haya devuelto más candidatos', async () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      customer({ id: `c-${String(i)}`, name: `Cliente ${String(i)}` }),
    );
    prisma.customer.findMany.mockResolvedValue(rows);

    const result = await service.search('cliente');

    expect(result).toHaveLength(20);
  });
});
