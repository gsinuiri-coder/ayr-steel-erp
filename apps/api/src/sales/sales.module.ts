import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { InventoryModule } from '../inventory/inventory.module';
import { JobsModule } from '../jobs/jobs.module';
import { QuotationExpiryJob } from './quotation-expiry.job';
import { QuotationsService } from './quotations.service';
import { SalesController } from './sales.controller';
import { SalesOrdersService } from './sales-orders.service';

/**
 * Ciclo comercial de Fase 5a (D-064..D-069): cotización → confirmación → pedido + reserva.
 *
 * Depende de `inventory` porque la confirmación comprueba el disponible bajo el mismo lock
 * de saldo que toma el kardex (regla dura 2: el ledger de reservas no escribe stock, lo
 * mira), y de `documents` para el PDF de la cotización en R2 (D-068).
 *
 * El guardrail que `inventory`, `coils`, `cutting` y `production` necesitan sobre el stock
 * reservado (D-066) **no** sale de este módulo: vive en `reservation-guard.ts` como función
 * suelta, por el mismo motivo que `production-assignments.ts` en Fase 4 — hacerlo un
 * provider metería a los cuatro en un ciclo de módulos con este.
 */
@Module({
  imports: [InventoryModule, DocumentsModule, JobsModule],
  controllers: [SalesController],
  providers: [QuotationsService, SalesOrdersService, QuotationExpiryJob],
  exports: [QuotationsService, SalesOrdersService],
})
export class SalesModule {}
