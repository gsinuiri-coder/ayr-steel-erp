import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BusinessLinesModule } from './business-lines/business-lines.module';
import { CatalogModule } from './catalog/catalog.module';
import { ColorsModule } from './colors/colors.module';
import { CoilsModule } from './coils/coils.module';
import { AppThrottlerGuard } from './common/throttler.guard';
import { ConfigModule } from './config/config.module';
import { ENV, type Env } from './config/env';
import { CustomersModule } from './customers/customers.module';
import { CuttingModule } from './cutting/cutting.module';
import { DocumentsModule } from './documents/documents.module';
import { ExchangeRatesModule } from './exchange-rates/exchange-rates.module';
import { FinishesModule } from './finishes/finishes.module';
import { HealthController } from './health/health.controller';
import { ImportsModule } from './imports/imports.module';
import { InventoryModule } from './inventory/inventory.module';
import { InvoicingModule } from './invoicing/invoicing.module';
import { JobsModule } from './jobs/jobs.module';
import { PricingModule } from './pricing/pricing.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductionModule } from './production/production.module';
import { PurchasesModule } from './purchases/purchases.module';
import { SalesModule } from './sales/sales.module';
import { SuppliersModule } from './suppliers/suppliers.module';
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
    BusinessLinesModule,
    FinishesModule,
    ColorsModule,
    CatalogModule,
    CustomersModule,
    SuppliersModule,
    PricingModule,
    ExchangeRatesModule,
    DocumentsModule,
    ImportsModule,
    InventoryModule,
    CoilsModule,
    PurchasesModule,
    CuttingModule,
    ProductionModule,
    SalesModule,
    InvoicingModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class AppModule {}
