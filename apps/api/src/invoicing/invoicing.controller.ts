import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  createCreditNoteSchema,
  createInvoiceSchema,
  fiscalDocumentQuerySchema,
  Role,
  updateInvoicingSettingsSchema,
  voidDocumentSchema,
  type CreateCreditNoteInput,
  type CreateInvoiceInput,
  type FiscalDocumentDto,
  type FiscalDocumentListItemDto,
  type FiscalDocumentQuery,
  type InvoicingSettingsDto,
  type SalesOrderProgressDto,
  type UpdateInvoicingSettingsInput,
  type VoidDocumentInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { InvoicingService } from './invoicing.service';

/**
 * Comprobantes electrónicos (RF-70, RF-74..RF-76).
 *
 * Rol base ADMINISTRADOR + VENDEDOR, igual que `sales` (§3.4): el vendedor factura lo que
 * vendió. Las excepciones son las que dejan huella fiscal difícil de deshacer y siguen el
 * criterio de D-046: **dar de baja** un comprobante y **tocar la configuración de
 * contingencia** son solo de ADMINISTRADOR.
 */
@Controller('invoicing')
@Roles(Role.ADMINISTRADOR, Role.VENDEDOR)
export class InvoicingController {
  constructor(private readonly invoicing: InvoicingService) {}

  // -------------------------------------------------------------------------
  // Configuración y alertas (D-073)
  // -------------------------------------------------------------------------

  /**
   * Va **antes** de `documents/:id` en el archivo por costumbre del proyecto, aunque acá
   * no colisionen: son prefijos distintos.
   */
  @Get('settings')
  settings(): Promise<InvoicingSettingsDto> {
    return this.invoicing.settings();
  }

  /** Interruptor de contingencia y umbral de alerta (D-073). Solo ADMINISTRADOR. */
  @Patch('settings')
  @Roles(Role.ADMINISTRADOR)
  updateSettings(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(updateInvoicingSettingsSchema)) body: UpdateInvoicingSettingsInput,
  ): Promise<InvoicingSettingsDto> {
    return this.invoicing.updateSettings(actor, body);
  }

  /** Cuántos documentos esperan aceptación y cuántos ya pasaron el umbral (D-073). */
  @Get('alerts')
  alerts(): Promise<{ pending: number; stalled: number }> {
    return this.invoicing.stalledCount();
  }

  /**
   * Barrido manual de pendientes (D-073). Lo corre el job; el endpoint existe porque el
   * API escala a cero y hace falta poder ponerlo al día bajo demanda —y probarlo de punta
   * a punta—, exactamente como `POST /sales/quotations/expire` (D-069).
   */
  @Post('send-pending')
  @Roles(Role.ADMINISTRADOR)
  async sendPending(): Promise<{ sent: number }> {
    return { sent: await this.invoicing.sendPending() };
  }

  /**
   * Lo que a cada línea de un pedido le queda por despachar y por facturar (D-074).
   * Lo consumen los dos formularios —comprobante y despacho—, que preguntan lo mismo.
   *
   * Lo lee además SUPERVISOR_PLANTA: el despacho es un acto de almacén, y sin esto la
   * pantalla de despacho no sabría cuánto puede sacar.
   */
  @Get('orders/:salesOrderId/progress')
  @Roles(Role.ADMINISTRADOR, Role.VENDEDOR, Role.SUPERVISOR_PLANTA)
  orderProgress(
    @Param('salesOrderId', ParseUUIDPipe) salesOrderId: string,
  ): Promise<SalesOrderProgressDto> {
    return this.invoicing.orderProgress(salesOrderId);
  }

  // -------------------------------------------------------------------------
  // Comprobantes
  // -------------------------------------------------------------------------

  @Get('documents')
  findAll(
    @Query(new ZodValidationPipe(fiscalDocumentQuerySchema)) query: FiscalDocumentQuery,
  ): Promise<FiscalDocumentListItemDto[]> {
    return this.invoicing.findAll(query);
  }

  @Get('documents/:id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<FiscalDocumentDto> {
    return this.invoicing.findOne(id);
  }

  /**
   * PDF, XML o CDR del comprobante, tal como los devolvió el PSE y guardados en R2. Se
   * descargan (`attachment`) y no se renderizan: el nombre sale de un correlativo del
   * sistema, pero descargar deja al navegador fuera del asunto, igual que el PDF de la
   * cotización.
   */
  @Get('documents/:id/pdf')
  pdf(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    return this.sendFile(id, 'pdf', res);
  }

  @Get('documents/:id/xml')
  xml(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    return this.sendFile(id, 'xml', res);
  }

  @Get('documents/:id/cdr')
  cdr(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    return this.sendFile(id, 'cdr', res);
  }

  private async sendFile(id: string, kind: 'pdf' | 'xml' | 'cdr', res: Response): Promise<void> {
    const { buffer, filename, contentType } = await this.invoicing.file(id, kind);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  /** RF-70: borrador. No toma correlativo ni habla con el PSE (D-072). */
  @Post('documents')
  create(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createInvoiceSchema)) body: CreateInvoiceInput,
  ): Promise<FiscalDocumentDto> {
    return this.invoicing.create(actor, body);
  }

  /** D-072/D-073: toma correlativo, deja el documento emitido y lo manda al PSE. */
  @Post('documents/:id/send')
  send(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FiscalDocumentDto> {
    return this.invoicing.send(actor, id);
  }

  /** D-073: reintento manual de un envío que no entró. */
  @Post('documents/:id/retry')
  retry(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FiscalDocumentDto> {
    return this.invoicing.retry(actor, id);
  }

  /** Consulta el estado real contra el PSE: resuelve pendientes y bajas en trámite. */
  @Post('documents/:id/refresh')
  refresh(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FiscalDocumentDto> {
    return this.invoicing.refreshStatus(actor, id);
  }

  /** RF-74: corrige un rechazado copiándolo a un borrador nuevo, con correlativo nuevo. */
  @Post('documents/:id/correct')
  correct(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FiscalDocumentDto> {
    return this.invoicing.correct(actor, id);
  }

  /** RF-76: nota de crédito, total o parcial, sobre un comprobante aceptado. */
  @Post('documents/:id/credit-note')
  creditNote(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createCreditNoteSchema)) body: CreateCreditNoteInput,
  ): Promise<FiscalDocumentDto> {
    return this.invoicing.createCreditNote(actor, id, body);
  }

  /** RF-75: comunicación de baja (D-046: solo ADMINISTRADOR). */
  @Post('documents/:id/void')
  @Roles(Role.ADMINISTRADOR)
  voidDocument(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(voidDocumentSchema)) body: VoidDocumentInput,
  ): Promise<FiscalDocumentDto> {
    return this.invoicing.voidDocument(actor, id, body.reason);
  }
}
