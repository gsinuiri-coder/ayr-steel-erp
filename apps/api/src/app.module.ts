import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AppThrottlerGuard } from './common/throttler.guard';
import { ConfigModule } from './config/config.module';
import { ENV, type Env } from './config/env';
import { HealthController } from './health/health.controller';
import { JobsModule } from './jobs/jobs.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuditModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ENV],
      useFactory: (env: Env) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
        // En E2E/CI se apaga para que la suite no reciba 429.
        skipIf: () => env.THROTTLE_DISABLED,
      }),
    }),
    AuthModule,
    UsersModule,
    JobsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class AppModule {}
