import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FiscalDocType, FiscalDocumentStatus, Prisma } from '@prisma/client';
import {
  Decimal,
  businessToday,
  documentBalance,
  toDecimal,
  toFixedString,
  type CreateCustomerPaymentInput,
  type ReceivableSummaryDto,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Cobranza y cuentas por cobrar (RF-86..RF-88; D-075).
 *
 * **Espejo exacto de `supplier_payments`** (D-039, D-061), y a propósito: el saldo
 * pendiente ya está resuelto en compras, y resolverlo distinto en ventas daría dos
 * verdades sobre la misma pregunta.
 *
 * Las tres reglas que hereda de ese espejo:
 *
 * 1. El saldo **se recalcula, nunca se almacena**.
 * 2. Un cobro va **contra el comprobante**, no contra el pedido: es lo que hace que el
 *    saldo cierre con facturación parcial o notas de crédito de por medio.
 * 3. Revertir **no borra la fila**: la marca `reversedAt`/`reversedById`, el monto vuelve
 *    al saldo y el motivo queda en la auditoría (el patrón de M-2).
 */

/**
 * Estados en los que el comprobante **es una deuda del cliente**.
 *
 * `SEND_ERROR` cuenta: el documento tomó correlativo, ya consume la línea del pedido y ya
 * habilita el despacho. Dejarlo fuera hacía que, con el PSE caído, la mercadería pudiera
 * salir pero el cobro no se pudiera registrar — la mitad de la promesa de D-073 sin
 * cumplir, y encima la mitad que se lleva el dinero.
 */
const LIVE_STATUSES: FiscalDocumentStatus[] = [
  FiscalDocumentStatus.ISSUED,
  FiscalDocumentStatus.SEND_ERROR,
  FiscalDocumentStatus.ACCEPTED,
  FiscalDocumentStatus.VOID_PENDING,
];

@Injectable()
export class ReceivablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Registra un cobro (RF-86).
   *
   * El saldo se recalcula **dentro de la transacción y con el comprobante bloqueado**, por
   * el mismo motivo que `PurchasesService.addPayment`: dos cobros concurrentes que por
   * separado caben en el saldo no pueden sobrepagarlo entre los dos.
   */
  async addPayment(
    actor: RequestUser,
    documentId: string,
    input: CreateCustomerPaymentInput,
  ): Promise<void> {
    await this.prisma.$transaction((tx) => this.addPaymentInTx(tx, actor, documentId, input));
  }

  /**
   * El cuerpo de `addPayment`, **dentro de una transacción que abre el llamador**, y
   * devolviendo el id del cobro.
   *
   * Lo usa el mostrador (RF-60, D-099): la venta de mostrador es contado por definición, así
   * que el cobro nace con el comprobante o no nace ninguno. Devuelve el id porque la venta
   * de mostrador lo guarda para poder revertir exactamente ese cobro al anularla (D-100).
   */
  async addPaymentInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    documentId: string,
    input: CreateCustomerPaymentInput,
  ): Promise<string> {
    await tx.$queryRaw`
      SELECT "id" FROM "fiscal_documents" WHERE "id" = ${documentId}::uuid FOR UPDATE
    `;
    const document = await tx.fiscalDocument.findUnique({
      where: { id: documentId },
      include: {
        payments: true,
        creditNotes: {
          // RF-72: una versión archivada dejó de ser el documento; no acredita nada.
          where: { status: { in: LIVE_STATUSES }, archivedAt: null },
          select: { totalPen: true },
        },
      },
    });
    if (!document) throw new NotFoundException('Comprobante no encontrado');

    if (document.docType === FiscalDocType.NOTA_CREDITO) {
      throw new BadRequestException(
        'Una nota de crédito no se cobra: ajusta el saldo del comprobante que afecta',
      );
    }
    if (document.docType === FiscalDocType.GUIA_REMISION_REMITENTE) {
      throw new BadRequestException('Una guía de remisión no tiene saldo que cobrar');
    }
    if (!LIVE_STATUSES.includes(document.status)) {
      throw new BadRequestException(
        document.status === FiscalDocumentStatus.DRAFT
          ? 'El comprobante todavía es un borrador: emítelo antes de cobrarlo'
          : `Un comprobante ${document.status} no tiene saldo que cobrar`,
      );
    }
    // RF-72: una reimportación lo dejó atrás. Cobrar sobre la versión archivada dejaría el
    // cobro colgado de un documento que ya no suma en ninguna cuenta por cobrar.
    if (document.archivedAt !== null) {
      throw new BadRequestException(
        'Este comprobante fue reemplazado por una reimportación posterior: cobra sobre la versión vigente',
      );
    }

    const balance = this.balanceOf(document);
    const amount = toDecimal(input.amountPen);
    if (amount.gt(balance)) {
      throw new BadRequestException(
        `El cobro excede el saldo pendiente (S/ ${balance.toFixed(2)})`,
      );
    }

    const payment = await tx.customerPayment.create({
      data: {
        documentId,
        date: new Date(`${input.date}T00:00:00.000Z`),
        amountPen: toFixedString(input.amountPen, 'MONEY'),
        method: input.method,
        reference: input.reference ?? null,
        createdById: actor.id,
      },
    });

    await this.audit.write(tx, {
      actorId: actor.id,
      action: 'invoicing.payment',
      entity: 'customer_payments',
      entityId: payment.id,
      after: {
        documentId,
        number: document.number,
        amountPen: payment.amountPen.toFixed(4),
        method: payment.method,
      },
    });
    return payment.id;
  }

  /**
   * Revierte un cobro (RF-87). Patrón de M-2/D-061 al pie: la fila nunca se borra.
   *
   * El cambio de estado va **primero y condicionado al estado leído** —el mismo `updateMany`
   * que usa `reversePayment` en compras—, de modo que dos reversas simultáneas del mismo
   * cobro no pueden convivir: la segunda no encuentra nada que actualizar y sale como 409.
   */
  async reversePayment(
    actor: RequestUser,
    documentId: string,
    paymentId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "fiscal_documents" WHERE "id" = ${documentId}::uuid FOR UPDATE
      `;
      const payment = await tx.customerPayment.findFirst({
        where: { id: paymentId, documentId },
      });
      if (!payment) throw new NotFoundException('Cobro no encontrado');

      const claimed = await tx.customerPayment.updateMany({
        where: { id: paymentId, reversedAt: null },
        data: { reversedAt: new Date(), reversedById: actor.id },
      });
      if (claimed.count === 0) throw new ConflictException('Ese cobro ya fue revertido');

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.payment-reverse',
        entity: 'customer_payments',
        entityId: paymentId,
        before: {
          documentId,
          amountPen: payment.amountPen.toFixed(4),
          method: payment.method,
        },
        after: { reason },
      });
    });
  }

  /**
   * Cuentas por cobrar por cliente (RF-88).
   *
   * Se arma en memoria sobre los comprobantes vivos y no con una consulta agregada porque
   * el saldo es **derivado** (D-075): sumarlo en SQL obligaría a duplicar ahí la regla que
   * ya vive en `@ayr/shared`, y esa duplicación es exactamente la que hace que la lista y
   * el detalle empiecen a decir números distintos.
   */
  async receivables(): Promise<ReceivableSummaryDto[]> {
    const documents = await this.prisma.fiscalDocument.findMany({
      where: {
        status: { in: LIVE_STATUSES },
        docType: { in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] },
        // RF-72: sin esto, reimportar un comprobante duplicaba la deuda del cliente — la
        // versión archivada sigue aceptada y volvía a sumar su total.
        archivedAt: null,
      },
      include: {
        customer: { select: { id: true, name: true, docNumber: true } },
        payments: { select: { amountPen: true, reversedAt: true } },
        creditNotes: {
          // RF-72: una versión archivada dejó de ser el documento; no acredita nada.
          where: { status: { in: LIVE_STATUSES }, archivedAt: null },
          select: { totalPen: true },
        },
      },
    });

    const today = businessToday();
    const byCustomer = new Map<string, ReceivableSummaryDto>();

    for (const doc of documents) {
      const balance = toDecimal(this.balanceOf(doc).toFixed(4));
      if (balance.lte(0)) continue;
      const dueDate = doc.dueDate ? doc.dueDate.toISOString().slice(0, 10) : null;
      const overdue = dueDate !== null && dueDate < today;

      const current = byCustomer.get(doc.customerId) ?? {
        customerId: doc.customer.id,
        customerName: doc.customer.name,
        customerDocNumber: doc.customer.docNumber,
        documentCount: 0,
        balancePen: '0.0000',
        overduePen: '0.0000',
        nextDueDate: null,
      };

      current.documentCount += 1;
      current.balancePen = toDecimal(current.balancePen).plus(balance).toFixed(4);
      if (overdue) {
        current.overduePen = toDecimal(current.overduePen).plus(balance).toFixed(4);
      }
      if (dueDate !== null && (current.nextDueDate === null || dueDate < current.nextDueDate)) {
        current.nextDueDate = dueDate;
      }
      byCustomer.set(doc.customerId, current);
    }

    return [...byCustomer.values()].sort((a, b) =>
      toDecimal(b.balancePen).cmp(toDecimal(a.balancePen)),
    );
  }

  /** El saldo de un comprobante, con la misma regla compartida que usa el DTO (D-075). */
  private balanceOf(document: {
    status: FiscalDocumentStatus;
    totalPen: Prisma.Decimal;
    payments: { amountPen: Prisma.Decimal; reversedAt: Date | null }[];
    creditNotes: { totalPen: Prisma.Decimal }[];
  }): Decimal {
    const paid = document.payments
      .filter((p) => p.reversedAt === null)
      .reduce((acc, p) => acc.plus(toDecimal(p.amountPen.toString())), new Decimal(0));
    const credited = document.creditNotes.reduce(
      (acc, n) => acc.plus(toDecimal(n.totalPen.toString())),
      new Decimal(0),
    );
    return toDecimal(
      documentBalance({
        status: document.status,
        totalPen: document.totalPen.toString(),
        paidPen: paid,
        creditedPen: credited,
      }),
    );
  }
}
