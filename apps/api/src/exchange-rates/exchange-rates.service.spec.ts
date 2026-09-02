import { Test } from '@nestjs/testing';
import { Currency, ExchangeRateSource } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { ExchangeRatesService } from './exchange-rates.service';

const admin: RequestUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'admin@ayr.test',
  name: 'Admin',
  role: 'ADMINISTRADOR',
  mustChangePassword: false,
  sessionId: 's-admin',
};

const cachedRow = {
  id: 'r-1',
  date: new Date('2026-01-05T00:00:00.000Z'),
  currency: Currency.USD,
  buy: { toFixed: () => '3.7500' } as unknown,
  sell: { toFixed: () => '3.7600' } as unknown,
  source: ExchangeRateSource.API,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('ExchangeRatesService (D-029/P-06)', () => {
  let service: ExchangeRatesService;
  const prisma = {
    exchangeRate: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  let env: Env;
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
    env = { APIS_NET_PE_TOKEN: 'token-de-prueba' } as Env;
    fetchMock = jest.fn();
    global.fetch = fetchMock;

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExchangeRatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: ENV, useValue: env },
      ],
    }).compile();
    service = moduleRef.get(ExchangeRatesService);
  });

  it('PEN no necesita consultar nada: TC 1:1', async () => {
    const dto = await service.getRate('2026-01-05', Currency.PEN);
    expect(dto.buy).toBe('1.0000');
    expect(dto.sell).toBe('1.0000');
    expect(prisma.exchangeRate.findUnique).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('usa la caché si ya existe un registro para esa fecha/moneda', async () => {
    prisma.exchangeRate.findUnique.mockResolvedValue(cachedRow);
    const dto = await service.getRate('2026-01-05', Currency.USD);
    expect(dto.source).toBe('API');
    expect(dto.buy).toBe('3.7500');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('API ok: consulta apis.net.pe y cachea el resultado con source=API', async () => {
    prisma.exchangeRate.findUnique.mockResolvedValue(null);
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ compra: 3.758, venta: 3.77 }),
    });
    prisma.exchangeRate.create.mockResolvedValue({
      ...cachedRow,
      buy: { toFixed: () => '3.7580' },
      sell: { toFixed: () => '3.7700' },
    });

    const dto = await service.getRate('2025-01-02', Currency.USD);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('fecha=2025-01-02'),
      expect.objectContaining({ headers: { Authorization: 'Bearer token-de-prueba' } }),
    );
    expect(prisma.exchangeRate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ buy: '3.7580', sell: '3.7700', source: 'API' }),
      }),
    );
    expect(dto.source).toBe('API');
  });

  it('API caída: cae al último tipo de cambio conocido (fallback manual)', async () => {
    prisma.exchangeRate.findUnique.mockResolvedValue(null);
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    prisma.exchangeRate.findFirst.mockResolvedValue({
      ...cachedRow,
      source: ExchangeRateSource.MANUAL,
    });

    const dto = await service.getRate('2025-01-02', Currency.USD);

    expect(prisma.exchangeRate.create).not.toHaveBeenCalled();
    expect(dto.source).toBe('MANUAL');
  });

  it('sin token y sin caché ni fallback: pide registro manual', async () => {
    env.APIS_NET_PE_TOKEN = '';
    prisma.exchangeRate.findUnique.mockResolvedValue(null);
    prisma.exchangeRate.findFirst.mockResolvedValue(null);

    await expect(service.getRate('2025-01-02', Currency.USD)).rejects.toThrow(
      'No hay tipo de cambio disponible',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('setManual guarda con source=MANUAL y audita', async () => {
    prisma.exchangeRate.upsert.mockResolvedValue({
      ...cachedRow,
      source: ExchangeRateSource.MANUAL,
    });
    const dto = await service.setManual(admin, {
      date: '2026-01-05',
      currency: Currency.USD,
      buy: '3.7500',
      sell: '3.7600',
    });
    expect(dto.source).toBe('MANUAL');
    expect(prisma.exchangeRate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ source: 'MANUAL' }) }),
    );
    expect(audit.write).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ action: 'exchange-rates.manual-set' }),
    );
  });
});
