import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { InventoryModule } from '../inventory/inventory.module';
import { JobsModule } from '../jobs/jobs.module';
import { ProductionModule } from '../production/production.module';
import { QuotationExpiryJob } from './quotation-expiry.job';
import { QuotationsService } from './quotations.service';
import { SalesController } from './sales.controller';
import { SalesOrderEditsService } from './sales-order-edits.service';
import { SalesOrdersService } from './sales-orders.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

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
  // D-186: `production` porque confirmar crea las OPs en la misma transacción que el pedido
  // (`createFromReservationInTx`). Producción no importa ventas, así que no hay ciclo.
  imports: [InventoryModule, DocumentsModule, JobsModule, ProductionModule],
  controllers: [SalesController, DashboardController],
  providers: [
    QuotationsService,
    SalesOrdersService,
    SalesOrderEditsService,
    QuotationExpiryJob,
    DashboardService,
  ],
  exports: [QuotationsService, SalesOrdersService],
})
export class SalesModule {}
