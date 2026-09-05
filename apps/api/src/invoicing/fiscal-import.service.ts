import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DocType,
  FiscalDocType,
  FiscalDocumentOrigin,
  FiscalDocumentStatus,
  PaymentTerms,
  Prisma,
  type CreditNoteReason,
} from '@prisma/client';
import {
  fiscalDocumentNumber,
  salesTotals,
  serializeSalesTotals,
  toDecimal,
  toFixedString,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { totalTolerance } from '../imports/fiscal-import-math';
import { PrismaService } from '../prisma/prisma.service';
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
  /**
   * El total que declara el papel. **Manda sobre la suma de las líneas** dentro de la
   * tolerancia de redondeo: es lo que SUNAT tiene y lo que el cliente debe, y si se
   * guardara el recalculado, cobrar el importe exacto del comprobante real se habría
   * rechazado por "excede el saldo pendiente".
   */
  totalPen: string;
  lines: ImportedDocumentLine[];
}

/** Estados en los que un comprobante **existe**: tomó número y sigue en pie. */
const LIVE_STATUSES: FiscalDocumentStatus[] = [
  FiscalDocumentStatus.ISSUED,
  FiscalDocumentStatus.SEND_ERROR,
  FiscalDocumentStatus.ACCEPTED,
  FiscalDocumentStatus.VOID_PENDING,
];

/**
 * Cuánto puede adelantar una importación el correlativo de una serie **activa** (D-106).
 *
 * Empujarlo es necesario —si no, el ERP volvería a entregar un número que SUNAT ya tiene—
 * pero no tiene vuelta atrás: no hay ninguna ruta que baje un correlativo, a propósito
 * (`setSeriesActive` lo dice: bajarlo emitiría dos veces el mismo número). Un `12345678`
 * tecleado donde iba `123` quemaría el rango de la serie con la que se factura de verdad,
 * así que un salto absurdo se rechaza en vez de aplicarse en silencio.
 */
export const MAX_ACTIVE_SERIES_JUMP = 1_000;

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Anula por dentro un comprobante **importado** (D-110): el ERP lo da por no existente y
   * su cuenta por cobrar desaparece.
   *
   * Es la reversa que RF-71 no trajo, y por eso vive acá, al lado de la importación: hasta
   * la Sesión M-4 un importado equivocado era deuda falsa permanente, porque nace `ACCEPTED`
   * y el PSE no lo conoce como nuestro (D-105), así que ni la baja ni la nota de crédito lo
   * alcanzaban. Es la cuarta vez que este proyecto paga la misma lección —D-061 con el pago
   * a proveedor, D-088 y D-097 con la reserva—: **la reversa se construye en la misma fase
   * que lo que revierte, o no se construye.**
   *
   * No es una baja ante SUNAT y no lo finge: estado propio (`ANNULLED`), columnas propias y
   * ningún viaje al proveedor. Sobre un comprobante que el ERP emitió, este camino se
   * rechaza — el suyo es el fiscal de D-072.
   */
  async annulImported(
    actor: RequestUser,
    id: string,
    reason: string,
  ): Promise<{ id: string; number: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      // El lock va antes de leer, igual que en `addPayment` y en la nota de crédito: sin él,
      // un cobro que entra mientras se decide la anulación queda colgado de un comprobante
      // que dejó de deber, y el guardrail de abajo no lo habría visto.
      await tx.$queryRaw`
        SELECT "id" FROM "fiscal_documents" WHERE "id" = ${id}::uuid FOR UPDATE
      `;
      const document = await tx.fiscalDocument.findUnique({
        where: { id },
        select: {
          id: true,
          number: true,
          origin: true,
          status: true,
          totalPen: true,
          archivedAt: true,
        },
      });
      if (!document) throw new NotFoundException('Comprobante no encontrado');

      if (document.origin !== FiscalDocumentOrigin.IMPORTED) {
        throw new BadRequestException(
          'Este comprobante lo emitió el ERP: se deshace con una baja o una nota de crédito ante SUNAT, no con una anulación interna',
        );
      }
      // Idempotencia explícita (D-052): un segundo intento no vuelve a anular ni finge que
      // hizo algo. 409 y no 400 porque el estado del recurso es el que impide la operación.
      if (document.status === FiscalDocumentStatus.ANNULLED) {
        throw new ConflictException(`El comprobante ${document.number ?? ''} ya está anulado`);
      }
      if (document.status !== FiscalDocumentStatus.ACCEPTED) {
        throw new BadRequestException(
          `Solo se anula un comprobante importado vigente; este está ${document.status}`,
        );
      }
      // Una versión archivada (RF-72) ya salió de todas las cuentas: anularla no cambiaría
      // ningún saldo y solo agregaría un estado terminal a una fila que es historial.
      if (document.archivedAt !== null) {
        throw new BadRequestException(
          'Esta versión ya fue reemplazada por una reimportación posterior: anula la vigente',
        );
      }

      // Los dos guardrails de `voidDocument`, por el mismo motivo y en el mismo orden: un
      // cobro vigente es dinero recibido —anular el comprobante lo dejaría sin causa— y una
      // nota de crédito viva ya ajustó este saldo por el otro camino.
      const payments = await tx.customerPayment.count({
        where: { documentId: id, reversedAt: null },
      });
      if (payments > 0) {
        throw new BadRequestException(
          'El comprobante tiene cobros vigentes: revierte los cobros antes de anularlo',
        );
      }
      const creditNotes = await tx.fiscalDocument.findMany({
        where: { affectedDocumentId: id, status: { in: LIVE_STATUSES }, archivedAt: null },
        select: { number: true },
      });
      if (creditNotes.length > 0) {
        throw new BadRequestException(
          `El comprobante tiene notas de crédito vivas (${creditNotes
            .map((n) => n.number ?? 'sin número')
            .join(', ')}): anúlalas primero`,
        );
      }

      const updated = await tx.fiscalDocument.update({
        where: { id },
        data: {
          status: FiscalDocumentStatus.ANNULLED,
          annulledAt: new Date(),
          annulledById: actor.id,
          annulReason: reason,
        },
        select: { id: true, number: true },
      });

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.import.annul',
        entity: 'fiscal_documents',
        entityId: id,
        before: { status: document.status, totalPen: document.totalPen.toFixed(4) },
        after: { status: FiscalDocumentStatus.ANNULLED, reason, number: document.number },
      });
      return updated;
    });
  }

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
    await this.assertCustomerUsableInTx(tx, input);
    const affectedDocType = await this.assertCreditNoteFitsInTx(tx, input);
    const previousId = await this.archivePreviousInTx(tx, number);
    const seriesId = await this.resolveSeriesInTx(tx, actorId, {
      series: input.series,
      docType: input.docType,
      correlative: input.correlative,
      affectedDocType,
    });

    const totals = this.resolveTotals(input);
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
        subtotalPen: totals.subtotalPen,
        igvPen: totals.igvPen,
        totalPen: totals.totalPen,
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
        totalPen: totals.totalPen,
        lines: input.lines.length,
        archivedDocumentId: previousId,
      },
    });
    // RF-95: el archivado necesita su **propia** entrada, con el id del archivado como
    // `entityId`. Contarlo solo dentro del registro del sucesor dejaba sin respuesta la
    // pregunta que alguien va a hacer de verdad: "¿por qué este comprobante salió de la
    // lista?", que se busca por el id del que desapareció.
    if (previousId) {
      await this.audit.write(tx, {
        actorId,
        action: 'invoicing.import.archive',
        entity: 'fiscal_documents',
        entityId: previousId,
        after: { archivedBy: document.id, number },
      });
    }
    return document.id;
  }

  /**
   * El total del comprobante importado: **manda el del papel**, y el IGV absorbe la
   * diferencia de redondeo contra la suma de las líneas.
   *
   * El subtotal sale de las líneas (es lo único que las líneas pueden decir) y el total, de
   * la planilla. Guardar el recalculado habría dejado el saldo por cobrar unos céntimos
   * lejos del comprobante real, y cobrar el importe exacto del papel se habría rechazado
   * por "excede el saldo pendiente". La diferencia admitida es la misma tolerancia que
   * valida el adaptador; acá se vuelve a comprobar porque este servicio es la autoridad, no
   * la pantalla.
   */
  private resolveTotals(input: ImportedDocumentInput): {
    subtotalPen: string;
    igvPen: string;
    totalPen: string;
  } {
    const computed = serializeSalesTotals(salesTotals(input.lines));
    const declared = toDecimal(input.totalPen);
    const diff = declared.minus(toDecimal(computed.totalPen)).abs();
    if (diff.gt(totalTolerance(input.lines.length))) {
      throw new BadRequestException(
        `Las líneas suman ${toDecimal(computed.totalPen).toFixed(2)} y el comprobante declara ${declared.toFixed(2)}`,
      );
    }
    const subtotal = toDecimal(computed.subtotalPen);
    const igv = declared.minus(subtotal);
    if (igv.isNegative()) {
      throw new BadRequestException(
        `El total declarado (${declared.toFixed(2)}) es menor que el valor de venta de sus líneas`,
      );
    }
    return {
      subtotalPen: toFixedString(subtotal, 'MONEY'),
      igvPen: toFixedString(igv, 'MONEY'),
      totalPen: toFixedString(declared, 'MONEY'),
    };
  }

  /**
   * El cliente del comprobante importado tiene que servir para emitirle (mismas tres
   * reglas que `InvoicingService.createInTx`, D-077).
   *
   * No es una repetición por descuido: importar es la **otra** puerta por la que nace un
   * comprobante, y una regla que solo vive en una de las dos no es una regla. Sin esto
   * entraban facturas contra un DNI o contra "público en general" —fiscalmente inválidas—
   * y cuentas por cobrar a nombre de clientes dados de baja.
   */
  private async assertCustomerUsableInTx(
    tx: Prisma.TransactionClient,
    input: ImportedDocumentInput,
  ): Promise<void> {
    const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw new BadRequestException('Cliente no encontrado');
    if (!customer.isActive) throw new BadRequestException('El cliente está desactivado');
    if (customer.isSystem && input.docType !== FiscalDocType.BOLETA) {
      throw new BadRequestException(
        'Al cliente "público en general" solo le corresponden boletas: usa un cliente identificado',
      );
    }
    if (input.docType === FiscalDocType.FACTURA && customer.docType !== DocType.RUC) {
      throw new BadRequestException(
        'Una factura va a un cliente con RUC; para este cliente corresponde una boleta',
      );
    }
  }

  /**
   * Una nota de crédito importada solo acredita a un comprobante **importado**, y no por
   * más de lo que a ese comprobante le queda.
   *
   * Las dos mitades cierran el mismo hueco. Sin la primera, una planilla podía borrar el
   * saldo de una factura que el ERP emitió de verdad con un documento que SUNAT nunca vio
   * —y de paso bloquearle la baja, porque una NC viva la bloquea—. Sin la segunda, podía
   * acreditar diez veces el total. Es el equivalente importado del tope que
   * `assertStillAvailable` aplica a la nota de crédito emitida acá.
   */
  private async assertCreditNoteFitsInTx(
    tx: Prisma.TransactionClient,
    input: ImportedDocumentInput,
  ): Promise<FiscalDocType | null> {
    if (input.docType !== FiscalDocType.NOTA_CREDITO || !input.affectedDocumentId) return null;
    const affected = await tx.fiscalDocument.findUnique({
      where: { id: input.affectedDocumentId },
      select: { number: true, origin: true, totalPen: true, archivedAt: true, docType: true },
    });
    if (!affected) throw new BadRequestException('El comprobante afectado no existe');
    if (affected.origin !== FiscalDocumentOrigin.IMPORTED) {
      throw new BadRequestException(
        `El comprobante ${affected.number ?? ''} lo emitió el ERP: su nota de crédito se emite acá, no se importa`,
      );
    }
    if (affected.archivedAt !== null) {
      throw new BadRequestException(
        `El comprobante ${affected.number ?? ''} fue reemplazado por una reimportación: acredita la versión vigente`,
      );
    }

    const credited = await tx.fiscalDocument.aggregate({
      where: {
        affectedDocumentId: input.affectedDocumentId,
        status: { in: LIVE_STATUSES },
        archivedAt: null,
      },
      _sum: { totalPen: true },
    });
    const already = toDecimal((credited._sum.totalPen ?? new Prisma.Decimal(0)).toString());
    const pending = toDecimal(affected.totalPen.toString()).minus(already);
    if (toDecimal(input.totalPen).gt(pending)) {
      throw new BadRequestException(
        `Al comprobante ${affected.number ?? ''} le quedan ${pending.toFixed(2)} por acreditar y esta nota acredita ${toDecimal(input.totalPen).toFixed(2)}`,
      );
    }
    return affected.docType;
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
    // El lock es sobre el **número**, no sobre las filas: un `FOR UPDATE` no bloquea nada
    // cuando todavía no existe ninguna, que es justo el caso de la primera importación, y
    // dos simultáneas del mismo comprobante terminaban chocando contra el índice único
    // parcial con un mensaje que no explica nada. Un lock consultivo de transacción existe
    // aunque la fila no, y se suelta solo al terminar.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${number})::bigint)`;
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
    actorId: string,
    spec: {
      series: string;
      docType: FiscalDocType;
      correlative: number;
      /** Solo en series de nota de crédito: el tipo del comprobante que afecta (D-072). */
      affectedDocType: FiscalDocType | null;
    },
  ): Promise<string> {
    const { series, docType, correlative, affectedDocType } = spec;
    const existing = await tx.fiscalSeries.findUnique({ where: { series } });
    if (!existing) {
      const created = await tx.fiscalSeries.create({
        // `affectedDocType` se completa aunque la serie nazca inactiva: sin él, el día que
        // alguien la active `allocateNumber` no la elegiría nunca —su filtro compara ese
        // campo con `IS NOT DISTINCT FROM`— y la serie quedaría activa y muerta.
        data: {
          docType,
          series,
          correlative,
          isActive: false,
          affectedDocType: docType === FiscalDocType.NOTA_CREDITO ? affectedDocType : null,
        },
      });
      // Una serie que nace sola tiene que dejar rastro igual que la que alguien da de alta
      // desde `/configuracion/series` (RF-95): es maestro fiscal, no un dato derivado.
      await this.audit.write(tx, {
        actorId,
        action: 'invoicing.series.create-from-import',
        entity: 'fiscal_series',
        entityId: created.id,
        after: { series, docType, correlative, isActive: false },
      });
      return created.id;
    }
    if (existing.docType !== docType) {
      throw new BadRequestException(
        `La serie ${series} está registrada para ${existing.docType} y el archivo la usa para ${docType}`,
      );
    }
    if (existing.correlative >= correlative) return existing.id;

    // El salto absurdo se rechaza **solo** en una serie activa y ya en uso: ahí el
    // correlativo es el próximo número que el ERP va a emitir de verdad, y no hay ruta que
    // lo baje. En una inactiva o recién creada, adelantarla es justo lo que se quiere.
    if (existing.isActive && existing.correlative > 0) {
      const jump = correlative - existing.correlative;
      if (jump > MAX_ACTIVE_SERIES_JUMP) {
        throw new BadRequestException(
          `El correlativo ${correlative} adelantaría la serie activa ${series} en ${jump} números (está en ${existing.correlative}): revisa el archivo, porque esto no se puede deshacer`,
        );
      }
    }

    // Atómico y no read-then-write: es el mismo recurso que `allocateNumber` mueve con
    // `UPDATE … RETURNING` (D-072). Con un `update` sobre lo leído, una emisión que
    // ocurriera entremedio quedaba pisada y el correlativo **retrocedía** — y el próximo
    // comprobante repetía un número que SUNAT ya tiene.
    const [row] = await tx.$queryRaw<{ before: number; after: number }[]>`
      UPDATE "fiscal_series" s
      SET "correlative" = GREATEST(s."correlative", ${correlative}), "updated_at" = NOW()
      FROM "fiscal_series" old
      WHERE s."id" = old."id" AND s."id" = ${existing.id}::uuid
      RETURNING old."correlative" AS "before", s."correlative" AS "after"
    `;
    if (row && row.before !== row.after) {
      await this.audit.write(tx, {
        actorId,
        action: 'invoicing.series.correlative-bump',
        entity: 'fiscal_series',
        entityId: existing.id,
        before: { correlative: row.before },
        after: { correlative: row.after, series, reason: 'importación de comprobante emitido' },
      });
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
