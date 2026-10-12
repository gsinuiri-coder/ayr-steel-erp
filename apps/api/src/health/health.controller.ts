import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * D-636: el commit con que se desplegó esta instancia. `deploy-api.mjs` pone en `GIT_SHA` el
 * mismo valor que el label `git-sha` de la revisión; `smoke:prod` lo lee de acá para verificar
 * la instancia que de verdad responde. Sin la variable (local, CI), «dev».
 */
export function deployedSha(env: NodeJS.ProcessEnv = process.env): string {
  return env.GIT_SHA?.trim() || 'dev';
}

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async check(): Promise<{
    status: 'ok' | 'degraded';
    db: 'ok' | 'error';
    uptime: number;
    sha: string;
  }> {
    let db: 'ok' | 'error' = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'error';
    }
    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      uptime: Math.round(process.uptime()),
      sha: deployedSha(),
    };
  }
}
