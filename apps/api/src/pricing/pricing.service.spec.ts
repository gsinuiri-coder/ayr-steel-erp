import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  minAllowedPrice,
  minAllowedValue,
  saleValueFromPrice,
  suggestedPrice,
  suggestedValue,
  updatePricingSettingSchema,
  valueForMargin,
} from '@ayr/shared';
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

describe('D-163 — margen sobre la venta, no markup sobre el costo', () => {
  it('el valor es costo ÷ (1 − margen), no costo × (1 + margen)', () => {
    // 100 ÷ 0.80 = 125, no 120. Es el cambio de política: los mínimos suben.
    expect(suggestedValue('100.0000', '20')).toBe('125.0000');
    expect(suggestedValue('100.0000', '20')).not.toBe('120.0000');
    // 50.50 ÷ 0.90 = 56.1111…
    expect(suggestedValue('50.5000', '10')).toBe('56.1111');
  });

  it('el margen que sale de la fórmula es el margen que se pidió', () => {
    // La comprobación al revés: con la fórmula vieja (markup) el margen real de un 20% era
    // del 16.67%, y esa diferencia es exactamente lo que D-163 vino a corregir.
    const value = valueForMargin('100.0000', '20');
    expect(value.minus(100).div(value).times(100).toFixed(4)).toBe('20.0000');
  });

  it('el precio sugerido es el valor con IGV', () => {
    // 100 ÷ 0.80 × 1.18 = 147.50
    expect(suggestedPrice('100.0000', '20')).toBe('147.5000');
  });

  it('margen 0% deja el valor igual al costo y el precio en costo + IGV', () => {
    expect(suggestedValue('80.0000', '0')).toBe('80.0000');
    expect(suggestedPrice('80.0000', '0')).toBe('94.4000');
  });

  it('minAllowedValue usa el margen mínimo, no el sugerido', () => {
    // 100 ÷ 0.90 = 111.1111
    expect(minAllowedValue('100.0000', '10')).toBe('111.1111');
    expect(minAllowedValue('100.0000', '10')).not.toBe(suggestedValue('100.0000', '20'));
  });

  it('el precio mínimo y el valor mínimo son el mismo piso, con y sin IGV', () => {
    // 111.1111 × 1.18 = 131.1111…
    expect(minAllowedPrice('100.0000', '10')).toBe('131.1111');
  });

  it('un margen de 100% o más no se puede calcular y lanza en vez de dar un piso negativo', () => {
    expect(() => valueForMargin('100.0000', '100')).toThrow(RangeError);
    expect(() => valueForMargin('100.0000', '120')).toThrow(RangeError);
  });

  it('el schema de márgenes rechaza 100% o más', () => {
    expect(updatePricingSettingSchema.safeParse({ marginPct: '100' }).success).toBe(false);
    expect(updatePricingSettingSchema.safeParse({ minMarginPct: '99.9' }).success).toBe(true);
  });

  it('en el mínimo exacto el valor guardado no cae por debajo del piso (D-163)', () => {
    // El caso que obliga a comparar **valor contra valor**: el vendedor tipea el precio
    // mínimo que la pantalla le muestra, el formulario lo divide por 1.18 y lo redondea a
    // cuatro decimales, y ese valor tiene que seguir pasando el piso. Comparando precios,
    // la diezmilésima que se pierde al redondear rebotaba justo el caso del borde.
    for (const cost of ['17.5000', '4.2000', '123.4567', '0.0100']) {
      const minValue = minAllowedValue(cost, '10');
      const minPrice = minAllowedPrice(cost, '10');
      const roundTrip = saleValueFromPrice(minPrice).toDecimalPlaces(4).toFixed(4);
      expect(Number(roundTrip)).toBeGreaterThanOrEqual(Number(minValue) - 0.0001);
      expect(Number(minValue)).toBeGreaterThanOrEqual(Number(cost));
    }
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
