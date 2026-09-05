import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  FiscalDocType,
  FiscalDocumentOrigin,
  FiscalDocumentStatus,
  PaymentTerms,
  Prisma,
  type CreditNoteReason,
} from '@prisma/client';
import { fiscalDocumentNumber, salesTotals, serializeSalesTotals } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import { dueDateFor } from './invoicing-math';

/** Una línea del comprobante importado, ya normalizada por el adaptador de planilla. */
export interface ImportedDocumentLine {
  productId: string | null;
  description: string;
  qty: string;
  unit: string;
  unitPricePen: string;
}

/** Un comprobante ya emitido afuera, listo para entrar (RF-71). */
export interface ImportedDocumentInput {
  docType: FiscalDocType;
  /** Serie tal como se imprime (`F001`). Cuatro caracteres. */
  series: string;
  correlative: number;
  issueDate: string;
  customerId: string;
  paymentTerms: PaymentTerms;
  /** Vencimiento explícito de la planilla; si falta, sale de los días de crédito del cliente. */
  dueDate: string | null;
  /** Solo en nota de crédito: el comprobante afectado, ya resuelto a id. */
  affectedDocumentId: string | null;
  creditNoteReason: CreditNoteReason | null;
  notes: string | null;
  lines: ImportedDocumentLine[];
}

/** Estados en los que un comprobante **existe**: tomó número y sigue en pie. */
const LIVE_STATUSES: FiscalDocumentStatus[] = [
  FiscalDocumentStatus.ISSUED,
  FiscalDocumentStatus.SEND_ERROR,
  FiscalDocumentStatus.ACCEPTED,
  FiscalDocumentStatus.VOID_PENDING,
];

function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * Importación de comprobantes **ya emitidos** (RF-71, RF-72; D-105..D-109).
 *
 * D-025 fijó qué es esto: el ERP emite contra el PSE desde la venta, y esta puerta existe
 * solo para lo que se emitió **afuera** —el histórico anterior al ERP y la emisión de
 * contingencia hecha en el portal de SUNAT durante una caída—. No es un segundo camino
 * para facturar: no toma correlativo de una serie activa, no habla con el PSE y no mueve
 * kardex.
 *
 * Sí crea cuenta por cobrar, que es justamente para lo que se importa: el comprobante que
 * la empresa emitió por fuera se cobra por dentro, con el flujo de cobranzas de siempre.
 *
 * Vive en `invoicing` y no en `imports` a propósito: las reglas de qué es un comprobante
 * válido —qué serie le corresponde, qué se puede reimportar, qué lo bloquea— son de este
 * módulo. El adaptador de planilla solo traduce filas.
 */
@Injectable()
export class FiscalImportService {
  constructor(private readonly audit: AuditService) {}

  /**
   * Crea el comprobante importado dentro de la transacción del llamador (patrón `*InTx`,
   * D-099) y devuelve su id. Si ya había una versión vigente **importada** con el mismo
   * número, la archiva primero (RF-72): la fila anterior se conserva entera y sale de la
   * lista, y la nueva queda apuntándola.
   */
  async importDocumentInTx(
    tx: Prisma.TransactionClient,
    input: ImportedDocumentInput,
    actorId: string,
  ): Promise<string> {
    const number = fiscalDocumentNumber(input.series, input.correlative);
    const previousId = await this.archivePreviousInTx(tx, number);
    const seriesId = await this.resolveSeriesInTx(
      tx,
      input.series,
      input.docType,
      input.correlative,
    );

    const totals = salesTotals(input.lines);
    const serialized = serializeSalesTotals(totals);
    const dueDate = await this.resolveDueDateInTx(tx, input);

    // `issuedAt`/`acceptedAt` salen de la fecha de emisión del papel, no del reloj: el
    // documento existió ese día, y ponerle la hora de la importación haría que un
    // comprobante del año pasado apareciera como emitido hoy en cualquier orden por fecha.
    const issuedAt = toDateOnly(input.issueDate);

    const document = await tx.fiscalDocument.create({
      data: {
        docType: input.docType,
        // Un comprobante importado ya pasó por SUNAT: nace aceptado y no entra al job de
        // reintento (D-073), que solo mira ISSUED y SEND_ERROR.
        status: FiscalDocumentStatus.ACCEPTED,
        origin: FiscalDocumentOrigin.IMPORTED,
        seriesId,
        correlative: input.correlative,
        number,
        customerId: input.customerId,
        affectedDocumentId: input.affectedDocumentId,
        creditNoteReason: input.creditNoteReason,
        supersedesDocumentId: previousId,
        issueDate: toDateOnly(input.issueDate),
        paymentTerms: input.paymentTerms,
        dueDate: dueDate ? toDateOnly(dueDate) : null,
        subtotalPen: serialized.subtotalPen,
        igvPen: serialized.igvPen,
        totalPen: serialized.totalPen,
        notes: input.notes,
        createdById: actorId,
        issuedAt,
        acceptedAt: issuedAt,
        items: {
          create: input.lines.map((line, i) => {
            const lineTotals = serializeSalesTotals(salesTotals([line]));
            return {
              lineNumber: i + 1,
              productId: line.productId,
              description: line.description,
              qty: line.qty,
              unit: line.unit,
              unitPricePen: line.unitPricePen,
              ...lineTotals,
            };
          }),
        },
      },
    });

    await this.audit.write(tx, {
      actorId,
      action: previousId ? 'invoicing.import.replace' : 'invoicing.import.create',
      entity: 'fiscal_documents',
      entityId: document.id,
      after: {
        number,
        docType: input.docType,
        totalPen: serialized.totalPen,
        lines: input.lines.length,
        archivedDocumentId: previousId,
      },
    });
    return document.id;
  }

  /**
   * RF-72 — reimportar **archiva** la versión anterior en vez de pisarla.
   *
   * Archivar es lo mismo que hace el resto del proyecto con lo que ya ocurrió: la fila se
   * marca, no se borra, y conserva sus líneas y su historial. Devuelve el id archivado, o
   * `null` si el número entra por primera vez.
   *
   * Las tres puertas cerradas dicen lo mismo desde tres lados: **solo se reimporta lo que
   * se importó, y solo mientras nada se apoye todavía en la versión anterior.**
   */
  private async archivePreviousInTx(
    tx: Prisma.TransactionClient,
    number: string,
  ): Promise<string | null> {
    // El lock va sobre las filas de ese número, incluidas las archivadas: sin él, dos
    // importaciones simultáneas del mismo comprobante archivaban cada una a la anterior y
    // dejaban dos vigentes —el índice único parcial las frena, pero con un error de base
    // en la cara del usuario en vez de un mensaje que se entienda.
    await tx.$queryRaw`
      SELECT "id" FROM "fiscal_documents" WHERE "number" = ${number} FOR UPDATE
    `;
    const previous = await tx.fiscalDocument.findFirst({
      where: { number, archivedAt: null },
      select: { id: true, origin: true, status: true },
    });
    if (!previous) return null;

    if (previous.origin !== FiscalDocumentOrigin.IMPORTED) {
      throw new ConflictException(
        `El comprobante ${number} lo emitió el ERP: no se puede reemplazar importando uno con el mismo número`,
      );
    }

    const payments = await tx.customerPayment.count({
      where: { documentId: previous.id, reversedAt: null },
    });
    if (payments > 0) {
      throw new BadRequestException(
        `El comprobante ${number} ya tiene cobros registrados: revierte los cobros antes de reimportarlo`,
      );
    }

    const creditNotes = await tx.fiscalDocument.count({
      where: { affectedDocumentId: previous.id, status: { in: LIVE_STATUSES }, archivedAt: null },
    });
    if (creditNotes > 0) {
      throw new BadRequestException(
        `El comprobante ${number} tiene notas de crédito que lo afectan: no se puede reimportar`,
      );
    }

    await tx.fiscalDocument.update({
      where: { id: previous.id },
      data: { archivedAt: new Date() },
    });
    return previous.id;
  }

  /**
   * La serie del comprobante importado (D-106).
   *
   * Un importado **no toma** correlativo: trae el suyo. Pero sí tiene que empujar el de la
   * serie hacia adelante si viene más arriba, porque si no el ERP volvería a entregar un
   * número que SUNAT ya tiene emitido — y dos comprobantes con el mismo número son un
   * problema fiscal, no un choque de índice.
   *
   * Una serie que no existe se crea **inactiva**: el histórico cuelga de ella y `allocateNumber`
   * no la ve, así que importar no habilita a emitir por una serie que nadie configuró.
   */
  private async resolveSeriesInTx(
    tx: Prisma.TransactionClient,
    series: string,
    docType: FiscalDocType,
    correlative: number,
  ): Promise<string> {
    const existing = await tx.fiscalSeries.findUnique({ where: { series } });
    if (!existing) {
      const created = await tx.fiscalSeries.create({
        data: { docType, series, correlative, isActive: false },
      });
      return created.id;
    }
    if (existing.docType !== docType) {
      throw new BadRequestException(
        `La serie ${series} está registrada para ${existing.docType} y el archivo la usa para ${docType}`,
      );
    }
    if (existing.correlative < correlative) {
      await tx.fiscalSeries.update({ where: { id: existing.id }, data: { correlative } });
    }
    return existing.id;
  }

  /**
   * Vencimiento de la cuenta por cobrar. Al contado no hay; a crédito manda la fecha de la
   * planilla y, si no vino, los días de crédito del cliente (D-075, mismo criterio que la
   * emisión normal).
   */
  private async resolveDueDateInTx(
    tx: Prisma.TransactionClient,
    input: ImportedDocumentInput,
  ): Promise<string | null> {
    if (input.paymentTerms !== PaymentTerms.CREDITO) return null;
    if (input.dueDate) return input.dueDate;
    const customer = await tx.customer.findUniqueOrThrow({
      where: { id: input.customerId },
      select: { creditDays: true },
    });
    return dueDateFor(input.issueDate, customer.creditDays);
  }
}
