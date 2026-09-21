import { Test, type TestingModule } from '@nestjs/testing';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@ayr/shared';

describe('DashboardService', () => {
  let service: DashboardService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        {
          provide: PrismaService,
          useValue: {
            quotation: { count: jest.fn() },
            quotationReservation: { count: jest.fn() },
            $queryRaw: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it('debe ejecutar exactamente 4 consultas agregadas para obtener el panel', async () => {
    const actor = {
      id: 'actor-id',
      email: 'a@b.c',
      role: Role.VENDEDOR,
      name: 'A B',
      sessionId: 'session-id',
      mustChangePassword: false,
    };

    jest.spyOn(prisma.quotation, 'count').mockResolvedValue(10);
    jest.spyOn(prisma.quotationReservation, 'count').mockResolvedValue(5);
    // $queryRaw returns array with count
    jest.spyOn(prisma, '$queryRaw').mockResolvedValue([{ count: 2n }]);

    const res = await service.getSellerDashboard(actor);

    expect(prisma.quotation.count).toHaveBeenCalledTimes(1);
    expect(prisma.quotationReservation.count).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);

    expect(res).toEqual({
      expiringQuotations: 10,
      expiringReservations: 5,
      productionOrders: 2,
      readyOrders: 2,
    });
  });
});
