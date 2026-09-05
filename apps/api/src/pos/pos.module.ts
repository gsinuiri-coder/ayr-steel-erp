import { Module } from '@nestjs/common';
import { InvoicingModule } from '../invoicing/invoicing.module';
import { SalesModule } from '../sales/sales.module';
import { CashSessionsService } from './cash-sessions.service';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';

/**
 * Punto de venta de mostrador (Fase 7b, RF-60; D-098..D-104).
 *
 * **El módulo más delgado del proyecto, y a propósito** (D-099). No importa `inventory`
 * porque no toca kardex, ni `documents` porque no genera archivos: importa los dos módulos
 * que ya hacen el trabajo —`sales` para el pedido y su reserva, `invoicing` para el
 * despacho, el comprobante y el cobro— y los compone en una transacción.
 *
 * Que las dependencias sean solo esas dos es la prueba de que el POS no abrió un camino
 * paralelo: si hubiera necesitado `InventoryService`, sería porque estaría moviendo stock
 * por su cuenta.
 */
@Module({
  imports: [SalesModule, InvoicingModule],
  controllers: [PosController],
  providers: [PosService, CashSessionsService],
  exports: [PosService, CashSessionsService],
})
export class PosModule {}
