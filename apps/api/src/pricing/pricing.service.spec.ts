import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { minAllowedPrice, suggestedPrice } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { PricingService } from './pricing.service';

const admin: RequestUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'admin@ayr.test',
  name: 'Admin',
  role: 'ADMINISTRADOR',
  mustChangePassword: false,
  sessionId: 's-admin',
};

const setting = {
  id: 'p-1',
  businessLineId: 'bl-1',
  businessLine: { code: 'DRYWALL' },
  marginPct: { toFixed: () => '20.0000' } as unknown,
  minMarginPct: { toFixed: () => '10.0000' } as unknown,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('suggestedPrice/minAllowedPrice (D-032/P-09)', () => {
  it('precio sugerido = costo × (1 + margen%)', () => {
    expect(suggestedPrice('100.0000', '20')).toBe('120.0000');
    expect(suggestedPrice('50.5000', '10')).toBe('55.5500');
  });

  it('margen 0% deja el precio igual al costo', () => {
    expect(suggestedPrice('80.0000', '0')).toBe('80.0000');
  });

  it('minAllowedPrice usa el margen mínimo, no el sugerido', () => {
    expect(minAllowedPrice('100.0000', '10')).toBe('110.0000');
    expect(minAllowedPrice('100.0000', '10')).not.toBe(suggestedPrice('100.0000', '20'));
  });
});

describe('PricingService.updateByBusinessLineId (D-032/P-09)', () => {
  let service: PricingService;
  const prisma = {
    pricingSetting: { findUnique: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        PricingService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(PricingService);
  });

  it('actualiza el margen cuando sigue siendo >= al mínimo', async () => {
    prisma.pricingSetting.findUnique.mockResolvedValue(setting);
    prisma.pricingSetting.update.mockResolvedValue({
      ...setting,
      marginPct: { toFixed: () => '15.0000' },
    });
    const dto = await service.updateByBusinessLineId(admin, 'bl-1', { marginPct: '15' });
    expect(dto.marginPct).toBe('15.0000');
    expect(audit.write).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ action: 'pricing.update' }),
    );
  });

  it('rechaza un margen menor que el margen mínimo vigente', async () => {
    prisma.pricingSetting.findUnique.mockResolvedValue(setting);
    await expect(
      service.updateByBusinessLineId(admin, 'bl-1', { marginPct: '5' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.pricingSetting.update).not.toHaveBeenCalled();
  });

  it('rechaza subir el mínimo por encima del margen vigente', async () => {
    prisma.pricingSetting.findUnique.mockResolvedValue(setting);
    await expect(
      service.updateByBusinessLineId(admin, 'bl-1', { minMarginPct: '25' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
