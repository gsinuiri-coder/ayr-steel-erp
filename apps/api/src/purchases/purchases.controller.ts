/// <reference types="multer" />
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  backdatableSchema,
  cancelPurchaseSchema,
  createPurchaseSchema,
  createSupplierPaymentSchema,
  businessToday,
  purchaseExportQuerySchema,
  purchaseQuerySchema,
  reversePaymentSchema,
  Role,
  updatePurchaseDocumentSchema,
  updatePurchaseItemSchema,
  type BackdatableInput,
  type CancelPurchaseInput,
  type CreatePurchaseInput,
  type CreateSupplierPaymentInput,
  type InvoiceXmlPreviewDto,
  type PaginatedResult,
  type PurchaseDto,
  type PurchaseListItemDto,
  type PurchaseExportQuery,
  type PurchaseQuery,
  type ReversePaymentInput,
  type SupplierStatementDto,
  type UpdatePurchaseDocumentInput,
  type UpdatePurchaseItemInput,
  commitReceivedPurchaseEditSchema,
  editReceivedPurchaseSchema,
  type CommitReceivedPurchaseEditInput,
  type EditReceivedPurchaseInput,
  type ReceivedEditPlanDto,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { sendXlsx } from '../common/list-export';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { purchasesXlsx } from './purchases-xlsx';
import { PurchasesService } from './purchases.service';
import { ReceivedPurchaseEditService } from './purchase-received-edit.service';

/** Una factura electrónica real pesa unos pocos KB; 2 MB es holgado y acota el DoS. */
const MAX_XML_BYTES = 2 * 1024 * 1024;

/**
 * Compras (D-030). Todo el módulo queda fuera del alcance de VENDEDOR (§3.4): expone
 * costos de compra y cuentas por pagar, que no son parte de su trabajo. Registrar y
 * recibir es de ADMINISTRADOR y SUPERVISOR_PLANTA (el supervisor maneja bobinas e
 * inventario, y la recepción es justamente eso); pagar, anular y el estado de cuenta
 * del proveedor son solo de ADMINISTRADOR.
 */
@Controller('purchases')
@Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
export class PurchasesController {
  constructor(
    private readonly purchases: PurchasesService,
    private readonly receivedEdit: ReceivedPurchaseEditService,
  ) {}

  /** D-372: vista previa de la edición de una compra recibida. No escribe nada. */
  @Post(':id/received-edit/preview')
  @Roles(Role.ADMINISTRADOR)
  previewReceivedEdit(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(editReceivedPurchaseSchema)) body: EditReceivedPurchaseInput,
  ): Promise<ReceivedEditPlanDto> {
    return this.receivedEdit.preview(actor, id, body);
  }

  /** D-372: confirmar la edición de una compra recibida, con motivo. */
  @Post(':id/received-edit')
  @Roles(Role.ADMINISTRADOR)
  async commitReceivedEdit(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(commitReceivedPurchaseEditSchema))
    body: CommitReceivedPurchaseEditInput,
  ): Promise<PurchaseDto> {
    await this.receivedEdit.commit(actor, id, body);
    return this.purchases.findOne(id);
  }

  @Get()
  findAll(
    @Query(new ZodValidationPipe(purchaseQuerySchema)) query: PurchaseQuery,
  ): Promise<PaginatedResult<PurchaseListItemDto>> {
    return this.purchases.findAll(query);
  }

  /**
   * cc26 M2 (D-provisional): el Excel de la lista de compras, con los filtros y el orden de la
   * pantalla, sin paginar y hasta `LIST_XLSX_MAX_ROWS` (más, 400). Mismos roles que la lista;
   * los importes solo van al ADMINISTRADOR (`purchases-xlsx.ts`). Va **antes** de `:id`: si
   * no, `ParseUUIDPipe` rechaza «xlsx» como id.
   */
  @Get('xlsx')
  async findAllXlsx(
    @CurrentUser() actor: RequestUser,
    @Query(new ZodValidationPipe(purchaseExportQuerySchema)) query: PurchaseExportQuery,
    @Res() res: Response,
  ): Promise<void> {
    const rows = await this.purchases.exportAll(query);
    sendXlsx(res, purchasesXlsx(rows, actor.role, businessToday()));
  }

  @Get('suppliers/:supplierId/statement')
  @Roles(Role.ADMINISTRADOR)
  statement(@Param('supplierId', ParseUUIDPipe) supplierId: string): Promise<SupplierStatementDto> {
    return this.purchases.supplierStatement(supplierId);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<PurchaseDto> {
    return this.purchases.findOne(id);
  }

  /** RF-11: sube el XML de la factura del proveedor y devuelve la compra prellenada. */
  @Post('xml/preview')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_XML_BYTES, files: 1 },
      fileFilter: (_req, file, cb) => {
        const isXml = /.xml$/i.test(file.originalname) || /xml/i.test(file.mimetype);
        cb(isXml ? null : new BadRequestException('Solo se admite un archivo .xml'), isXml);
      },
    }),
  )
  previewXml(
    @CurrentUser() actor: RequestUser,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<InvoiceXmlPreviewDto> {
    if (!file) throw new BadRequestException('Falta el archivo XML');
    return this.purchases.previewFromXml(actor, {
      originalname: file.originalname,
      buffer: file.buffer,
    });
  }

  @Post()
  @Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
  create(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createPurchaseSchema)) body: CreatePurchaseInput,
  ): Promise<PurchaseDto> {
    return this.purchases.create(actor, body);
  }

  /**
   * Recibir la compra (D-030). El cuerpo es opcional y solo lleva la fecha de operación
   * (D-124): sin él, la recepción se fecha hoy, que es el caso de todos los días.
   */
  @Post(':id/receive')
  @Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
  receive(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(backdatableSchema)) body: BackdatableInput,
  ): Promise<PurchaseDto> {
    return this.purchases.receive(actor, id, body);
  }

  /**
   * Corregir serie y número del comprobante (D-132). Dato de cáscara, sin efectos sobre
   * costos, kardex ni saldos; solo ADMINISTRADOR y queda en `audit_log`.
   */
  @Patch(':id/document')
  @Roles(Role.ADMINISTRADOR)
  updateDocument(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updatePurchaseDocumentSchema)) body: UpdatePurchaseDocumentInput,
  ): Promise<PurchaseDto> {
    return this.purchases.updateDocument(actor, id, body);
  }

  /** D-371: corregir una línea de una compra en borrador (cantidad y costo unitario). */
  @Patch(':id/items/:itemId')
  @Roles(Role.ADMINISTRADOR)
  updateItem(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body(new ZodValidationPipe(updatePurchaseItemSchema)) body: UpdatePurchaseItemInput,
  ): Promise<PurchaseDto> {
    return this.purchases.updateItem(actor, id, itemId, body);
  }

  /** D-371: quitar una línea de una compra en borrador (nunca la última). */
  @Delete(':id/items/:itemId')
  @Roles(Role.ADMINISTRADOR)
  deleteItem(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<PurchaseDto> {
    return this.purchases.deleteItem(actor, id, itemId);
  }

  @Post(':id/payments')
  @Roles(Role.ADMINISTRADOR)
  addPayment(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createSupplierPaymentSchema)) body: CreateSupplierPaymentInput,
  ): Promise<PurchaseDto> {
    return this.purchases.addPayment(actor, id, body);
  }

  /** Anular un pago a proveedor (Sesión M-2, cierra D-039). El saldo vuelve a incluirlo. */
  @Post(':id/payments/:paymentId/reverse')
  @Roles(Role.ADMINISTRADOR)
  reversePayment(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body(new ZodValidationPipe(reversePaymentSchema)) body: ReversePaymentInput,
  ): Promise<PurchaseDto> {
    return this.purchases.reversePayment(actor, id, paymentId, body);
  }

  @Post(':id/cancel')
  @Roles(Role.ADMINISTRADOR)
  cancel(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(cancelPurchaseSchema)) body: CancelPurchaseInput,
  ): Promise<PurchaseDto> {
    return this.purchases.cancel(actor, id, body);
  }
}
