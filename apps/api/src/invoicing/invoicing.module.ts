import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { ConfigModule } from '../config/config.module';
import { DocumentsModule } from '../documents/documents.module';
import { InventoryModule } from '../inventory/inventory.module';
import { JobsModule } from '../jobs/jobs.module';
import { DispatchesController } from './dispatches.controller';
import { DispatchesService } from './dispatches.service';
import { ReceivablesService } from './receivables.service';
import { InvoicingController } from './invoicing.controller';
import { InvoicingSendJob } from './invoicing-send.job';
import { InvoicingService } from './invoicing.service';
import {
  ELECTRONIC_INVOICING_PROVIDER,
  type ElectronicInvoicingProvider,
} from './ports/electronic-invoicing.port';
import { NullInvoicingProvider } from './providers/null-invoicing.provider';
import { NubefactProvider } from './providers/nubefact/nubefact.provider';

/**
 * Facturación electrónica (Fase 5b, D-070..D-078).
 *
 * **Este archivo es el único lugar donde el proyecto decide qué PSE se usa** (D-071). El
 * servicio recibe el puerto por token y no sabe qué hay del otro lado; cambiar de
 * proveedor es cambiar esta fábrica y escribir un adaptador, nada más.
 *
 * Sin credenciales se ata `NullInvoicingProvider`, que responde con error de envío. No es
 * un modo degradado: es la ruta de contingencia de D-073, así que un entorno sin PSE
 * ejercita exactamente el mismo camino que una caída real.
 */
@Module({
  // `inventory` porque el despacho **mueve kardex** (regla dura 2): la salida la escribe
  // `InventoryService`, nunca este módulo.
  imports: [ConfigModule, DocumentsModule, InventoryModule, JobsModule],
  controllers: [InvoicingController, DispatchesController],
  providers: [
    InvoicingService,
    DispatchesService,
    ReceivablesService,
    InvoicingSendJob,
    {
      provide: ELECTRONIC_INVOICING_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env): ElectronicInvoicingProvider =>
        env.NUBEFACT_URL && env.NUBEFACT_TOKEN
          ? new NubefactProvider(env.NUBEFACT_URL, env.NUBEFACT_TOKEN)
          : new NullInvoicingProvider(),
    },
  ],
  exports: [InvoicingService, DispatchesService],
})
export class InvoicingModule {}
