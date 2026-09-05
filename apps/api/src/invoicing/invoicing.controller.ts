import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  createCreditNoteSchema,
  createCustomerPaymentSchema,
  createFiscalSeriesSchema,
  createInvoiceSchema,
  fiscalDocumentQuerySchema,
  reverseCustomerPaymentSchema,
  Role,
  updateFiscalSeriesSchema,
  updateInvoicingSettingsSchema,
  voidDocumentSchema,
  type CreateCreditNoteInput,
  type CreateCustomerPaymentInput,
  type CreateFiscalSeriesInput,
  type CreateInvoiceInput,
  type FiscalDocumentDto,
  type FiscalDocumentListItemDto,
  type FiscalDocumentQuery,
  type FiscalSeriesDto,
  type InvoicingSettingsDto,
  type ReceivableSummaryDto,
  type ReverseCustomerPaymentInput,
  type SalesOrderProgressDto,
  type UpdateFiscalSeriesInput,
  type UpdateInvoicingSettingsInput,
  type VoidDocumentInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { FiscalImportService } from './fiscal-import.service';
import { InvoicingService } from './invoicing.service';
import { ReceivablesService } from './receivables.service';

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
  constructor(
    private readonly invoicing: InvoicingService,
    private readonly receivablesService: ReceivablesService,
    private readonly fiscalImport: FiscalImportService,
  ) {}

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

  /**
   * Series del punto de emisión (D-072).
   *
   * Se administran porque **la autorización es del PSE por emisor**: la serie que sirve en
   * una cuenta no sirve en otra, y descubrirlo cuesta un correlativo rechazado por cada
   * intento. Solo ADMINISTRADOR: una serie mal puesta rompe la numeración fiscal.
   */
  @Get('series')
  @Roles(Role.ADMINISTRADOR)
  findSeries(): Promise<FiscalSeriesDto[]> {
    return this.invoicing.findSeries();
  }

  @Post('series')
  @Roles(Role.ADMINISTRADOR)
  createSeries(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createFiscalSeriesSchema)) body: CreateFiscalSeriesInput,
  ): Promise<FiscalSeriesDto> {
    return this.invoicing.createSeries(actor, body);
  }

  @Patch('series/:id')
  @Roles(Role.ADMINISTRADOR)
  updateSeries(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateFiscalSeriesSchema)) body: UpdateFiscalSeriesInput,
  ): Promise<FiscalSeriesDto> {
    return this.invoicing.setSeriesActive(actor, id, body.isActive);
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
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
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
    @CurrentUser() actor: RequestUser,
    @Param('salesOrderId', ParseUUIDPipe) salesOrderId: string,
  ): Promise<SalesOrderProgressDto> {
    return this.invoicing.orderProgress(salesOrderId, {
      withPrices: actor.role !== Role.SUPERVISOR_PLANTA,
    });
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
    // El nombre sale de un correlativo del sistema y hoy no puede llevar comillas ni
    // saltos de línea; se sanea igual para que un futuro alta de series no reabra la
    // inyección de cabecera.
    const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
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

  /**
   * Descarta un borrador. Es lo único que se borra en este módulo, y solo porque un
   * borrador no existe fiscalmente (D-072).
   */
  @Delete('documents/:id')
  @HttpCode(204)
  discardDraft(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.invoicing.discardDraft(actor, id);
  }

  /** D-072/D-073: toma correlativo, deja el documento emitido y lo manda al PSE. */
  // Throttle propio, como el lookup de RUC (D-067): cada llamada sale a un servicio
  // externo con nuestro token **y gasta un correlativo**, que es peor que gastar cuota.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('documents/:id/send')
  send(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FiscalDocumentDto> {
    return this.invoicing.send(actor, id);
  }

  /** D-073: reintento manual de un envío que no entró. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('documents/:id/retry')
  retry(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FiscalDocumentDto> {
    return this.invoicing.retry(actor, id);
  }

  /** Consulta el estado real contra el PSE: resuelve pendientes y bajas en trámite. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
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

  // -------------------------------------------------------------------------
  // Cobranza (RF-86..RF-88, D-075)
  // -------------------------------------------------------------------------

  /**
   * Cuentas por cobrar agregadas por cliente (RF-88).
   *
   * Va **antes** de `documents/:id` en el archivo por orden de lectura; son prefijos
   * distintos y no colisionan.
   */
  @Get('receivables')
  receivables(): Promise<ReceivableSummaryDto[]> {
    return this.receivablesService.receivables();
  }

  /**
   * RF-86: registra un cobro.
   *
   * ADMINISTRADOR **y VENDEDOR**, a diferencia del pago a proveedor, que es solo de
   * ADMINISTRADOR: compras es un módulo de planta al que el vendedor no entra, y cobrar es
   * parte de su trabajo (D-075).
   */
  @Post('documents/:id/payments')
  async addPayment(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createCustomerPaymentSchema)) body: CreateCustomerPaymentInput,
  ): Promise<FiscalDocumentDto> {
    await this.receivablesService.addPayment(actor, id, body);
    return this.invoicing.findOne(id);
  }

  /** RF-87: revierte un cobro (D-046: solo ADMINISTRADOR). La fila nunca se borra. */
  @Post('documents/:id/payments/:paymentId/reverse')
  @Roles(Role.ADMINISTRADOR)
  async reversePayment(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body(new ZodValidationPipe(reverseCustomerPaymentSchema)) body: ReverseCustomerPaymentInput,
  ): Promise<FiscalDocumentDto> {
    await this.receivablesService.reversePayment(actor, id, paymentId, body.reason);
    return this.invoicing.findOne(id);
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

  /**
   * D-110: anulación **interna** de un comprobante importado (RF-71).
   *
   * Ruta aparte de `/void` y no una bandera suya: son dos operaciones distintas sobre dos
   * clases de documento distintas —una comunica una baja a SUNAT, la otra no habla con
   * nadie—, y meterlas en el mismo endpoint habría hecho que el permiso, el motivo y el
   * desenlace dependieran de un `origin` que el llamador no ve. Solo ADMINISTRADOR, igual
   * que la baja, porque el efecto sobre la cuenta por cobrar es el mismo.
   */
  @Post('documents/:id/annul')
  @Roles(Role.ADMINISTRADOR)
  async annulImported(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(voidDocumentSchema)) body: VoidDocumentInput,
  ): Promise<FiscalDocumentDto> {
    await this.fiscalImport.annulImported(actor, id, body.reason);
    return this.invoicing.findOne(id);
  }
}
