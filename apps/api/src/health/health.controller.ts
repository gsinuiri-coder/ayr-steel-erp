import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async check(): Promise<{ status: 'ok' | 'degraded'; db: 'ok' | 'error'; uptime: number }> {
    let db: 'ok' | 'error' = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'error';
    }
    return { status: db === 'ok' ? 'ok' : 'degraded', db, uptime: Math.round(process.uptime()) };
  }
}
