import { BadRequestException, Injectable } from '@nestjs/common';
import {
  FiscalDocType,
  FiscalDocumentOrigin,
  PaymentTerms,
  type CreditNoteReason,
  type Prisma,
} from '@prisma/client';
import {
  businessToday,
  CREDIT_NOTE_REASONS,
  Decimal,
  decimalStringSchema,
  fiscalDocumentNumber,
  ImportEntity,
  INVOICE_DOC_TYPES,
  MAX_VALUE,
  PAYMENT_TERMS,
  salesTotals,
  toDecimal,
  type FiscalDocType as SharedFiscalDocType,
} from '@ayr/shared';
import {
  FiscalImportService,
  type ImportedDocumentLine,
} from '../../invoicing/fiscal-import.service';
import { asText, mismatchedHeaderLabels, totalMismatch } from '../fiscal-import-math';
import { PrismaService } from '../../prisma/prisma.service';
import {
  getField,
  type GroupedImportAdapter,
  type GroupRow,
  type ImportColumn,
  type RowIssues,
  type RowValidation,
} from './import-adapter.interface';

/**
 * La planilla trae **una fila por línea** y repite la cabecera en todas las del mismo
 * comprobante. Es la forma en la que cualquier sistema de facturación exporta lo emitido,
 * y la que permite que un comprobante de seis líneas se corrija línea por línea en la
 * previsualización.
 */
const COLUMNS = {
  docType: { key: 'docType', header: 'Tipo (FACTURA/BOLETA/NOTA_CREDITO)', required: true },
  series: { key: 'series', header: 'Serie', required: true },
  correlative: { key: 'correlative', header: 'Correlativo', required: true },
  issueDate: { key: 'issueDate', header: 'Fecha de emisión', required: true },
  customerDocNumber: { key: 'customerDocNumber', header: 'Cliente (RUC/DNI)', required: true },
  paymentTerms: {
    key: 'paymentTerms',
    header: 'Condición de pago (CONTADO/CREDITO)',
    required: false,
  },
  dueDate: { key: 'dueDate', header: 'Fecha de vencimiento', required: false },
  totalPen: { key: 'totalPen', header: 'Total del comprobante', required: true },
  affectedNumber: { key: 'affectedNumber', header: 'Documento afectado (NC)', required: false },
  creditNoteReason: { key: 'creditNoteReason', header: 'Motivo de la NC', required: false },
  notes: { key: 'notes', header: 'Notas', required: false },
  sku: { key: 'sku', header: 'SKU', required: false },
  description: { key: 'description', header: 'Descripción', required: true },
  qty: { key: 'qty', header: 'Cantidad', required: true },
  unit: { key: 'unit', header: 'Unidad', required: false },
  unitPricePen: { key: 'unitPricePen', header: 'Precio unitario sin IGV', required: true },
} satisfies Record<string, ImportColumn>;

/** Los campos que describen al **documento** y tienen que decir lo mismo en cada línea. */
const HEADER_FIELDS: { key: keyof typeof COLUMNS; label: string }[] = [
  { key: 'docType', label: 'el tipo' },
  { key: 'issueDate', label: 'la fecha de emisión' },
  { key: 'customerDocNumber', label: 'el cliente' },
  { key: 'paymentTerms', label: 'la condición de pago' },
  { key: 'dueDate', label: 'la fecha de vencimiento' },
  { key: 'totalPen', label: 'el total' },
  { key: 'affectedNumber', label: 'el documento afectado' },
  { key: 'creditNoteReason', label: 'el motivo de la nota de crédito' },
];

const qtySchema = decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG });
const priceSchema = decimalStringSchema('MONEY', { max: MAX_VALUE.MONEY });
const totalSchema = decimalStringSchema('MONEY', { positive: true, max: MAX_VALUE.MONEY });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Serie de SUNAT: cuatro caracteres alfanuméricos en mayúscula (`F001`, `BC01`). */
const SERIES_RE = /^[A-Z][A-Z0-9]{3}$/;
const MAX_CORRELATIVE = 99_999_999;
/** Unidad por defecto del catálogo 03 de SUNAT: "unidad (bienes)". */
const DEFAULT_UNIT = 'NIU';

function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Importación de comprobantes ya emitidos (RF-71, RF-72; D-105..D-109).
 *
 * Traduce planilla a comprobante y nada más: qué es un comprobante válido, qué serie le
 * toca y qué se puede reimportar lo decide `FiscalImportService`, que es de `invoicing`.
 */
@Injectable()
export class FiscalDocumentsImportAdapter implements GroupedImportAdapter {
  entity = ImportEntity.FISCAL_DOCUMENTS;
  columns = Object.values(COLUMNS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fiscalImport: FiscalImportService,
  ) {}

  // -------------------------------------------------------------------------
  // Una fila: la línea y su parte de la cabecera
  // -------------------------------------------------------------------------

  async validateRow(raw: Record<string, unknown>): Promise<RowValidation> {
    const docType = getField(raw, COLUMNS.docType).toUpperCase().replace(/\s+/g, '_');
    const series = getField(raw, COLUMNS.series).toUpperCase();
    const correlativeRaw = getField(raw, COLUMNS.correlative);
    const issueDate = getField(raw, COLUMNS.issueDate);
    const customerDocNumber = getField(raw, COLUMNS.customerDocNumber);
    const paymentTerms = (
      getField(raw, COLUMNS.paymentTerms) || PaymentTerms.CONTADO
    ).toUpperCase();
    const dueDate = getField(raw, COLUMNS.dueDate);
    const totalPen = getField(raw, COLUMNS.totalPen);
    const affectedNumber = getField(raw, COLUMNS.affectedNumber).toUpperCase();
    const creditNoteReason = getField(raw, COLUMNS.creditNoteReason).toUpperCase();
    const notes = getField(raw, COLUMNS.notes);
    const sku = getField(raw, COLUMNS.sku).toUpperCase();
    const description = getField(raw, COLUMNS.description);
    const qty = getField(raw, COLUMNS.qty);
    const unit = (getField(raw, COLUMNS.unit) || DEFAULT_UNIT).toUpperCase();
    const unitPricePen = getField(raw, COLUMNS.unitPricePen);

    const errors: string[] = [];
    const data: Record<string, unknown> = {
      docType,
      series,
      correlative: correlativeRaw,
      issueDate,
      customerDocNumber,
      paymentTerms,
      dueDate,
      totalPen,
      affectedNumber,
      creditNoteReason,
      notes,
      sku,
      description,
      qty,
      unit,
      unitPricePen,
    };

    if (!INVOICE_DOC_TYPES.includes(docType as SharedFiscalDocType)) {
      errors.push(`Tipo de comprobante inválido: "${docType}" (FACTURA, BOLETA o NOTA_CREDITO)`);
    }
    if (!SERIES_RE.test(series)) {
      errors.push(`Serie inválida: "${series}" (cuatro caracteres, ej. F001)`);
    }

    const correlative = Number(correlativeRaw);
    if (!Number.isInteger(correlative) || correlative <= 0 || correlative > MAX_CORRELATIVE) {
      errors.push(`Correlativo inválido: "${correlativeRaw}"`);
    } else {
      data.correlative = correlative;
    }

    if (!isValidDate(issueDate)) {
      errors.push(`Fecha de emisión inválida: "${issueDate}" (formato AAAA-MM-DD)`);
    } else if (issueDate > businessToday()) {
      // Un comprobante que "se emitió mañana" es siempre un error de tipeo, y entra como
      // una venta que todavía no ocurrió en todo reporte por fecha.
      errors.push(`La fecha de emisión ${issueDate} está en el futuro`);
    }

    if (!PAYMENT_TERMS.includes(paymentTerms as PaymentTerms)) {
      errors.push(`Condición de pago inválida: "${paymentTerms}" (CONTADO o CREDITO)`);
    }
    if (dueDate) {
      if (!isValidDate(dueDate)) {
        errors.push(`Fecha de vencimiento inválida: "${dueDate}" (formato AAAA-MM-DD)`);
      } else if (paymentTerms !== PaymentTerms.CREDITO) {
        errors.push('Solo un comprobante al crédito lleva fecha de vencimiento');
      } else if (isValidDate(issueDate) && dueDate < issueDate) {
        errors.push('La fecha de vencimiento es anterior a la de emisión');
      }
    }

    const parsedTotal = totalSchema.safeParse(totalPen);
    if (!parsedTotal.success) errors.push(`Total del comprobante inválido: "${totalPen}"`);
    else data.totalPen = parsedTotal.data;

    if (docType === FiscalDocType.NOTA_CREDITO) {
      if (!affectedNumber) errors.push('Una nota de crédito necesita el documento afectado');
      if (!CREDIT_NOTE_REASONS.includes(creditNoteReason as CreditNoteReason)) {
        errors.push(`Motivo de nota de crédito inválido: "${creditNoteReason}"`);
      }
    } else {
      if (affectedNumber) {
        errors.push('Solo una nota de crédito afecta a otro comprobante');
      }
      if (creditNoteReason) errors.push('Solo una nota de crédito lleva motivo');
    }

    if (!description) errors.push('Falta la descripción de la línea');
    if (description.length > 240) errors.push('La descripción supera los 240 caracteres');
    if (notes.length > 500) errors.push('Las notas superan los 500 caracteres');
    if (unit.length > 20) errors.push(`Unidad inválida: "${unit}"`);

    const parsedQty = qtySchema.safeParse(qty);
    if (!parsedQty.success) errors.push(`Cantidad inválida: "${qty}"`);
    else data.qty = parsedQty.data;

    const parsedPrice = priceSchema.safeParse(unitPricePen);
    if (!parsedPrice.success) errors.push(`Precio unitario inválido: "${unitPricePen}"`);
    else if (toDecimal(parsedPrice.data).isNegative())
      errors.push('El precio unitario es negativo');
    else data.unitPricePen = parsedPrice.data;

    // El cliente tiene que existir: importar comprobantes no da de alta clientes. Si falta,
    // se importa primero el maestro (RF-52), que es su propio archivo y su propia pantalla.
    if (customerDocNumber) {
      const matches = await this.prisma.customer.findMany({
        where: { docNumber: customerDocNumber },
        select: { id: true },
        take: 2,
      });
      const customer = matches[0];
      if (!customer) {
        errors.push(`Cliente no encontrado: ${customerDocNumber} (impórtalo primero)`);
      } else if (matches.length > 1) {
        // `customers` es único por (tipo, número), así que el mismo número puede repetirse
        // con DNI y con RUC. La planilla trae el número pelado y no alcanza para elegir.
        errors.push(`Hay más de un cliente con el documento ${customerDocNumber}`);
      } else {
        data.customerId = customer.id;
      }
    }

    // El SKU es único **por línea de negocio**, no en todo el catálogo: si el mismo código
    // existe en dos líneas, la planilla no dice cuál, y la línea entra sin producto antes
    // que con el equivocado.
    if (sku) {
      const products = await this.prisma.product.findMany({
        where: { sku },
        select: { id: true },
        take: 2,
      });
      const product = products[0];
      if (!product) errors.push(`SKU no encontrado: ${sku}`);
      else if (products.length > 1) errors.push(`El SKU ${sku} existe en más de una línea`);
      else data.productId = product.id;
    }

    return { data, errors };
  }

  /**
   * Sin clave de deduplicación a propósito: dos líneas idénticas dentro del mismo
   * comprobante son legítimas (dos entregas del mismo producto al mismo precio), y lo que
   * sí hay que detectar —el mismo comprobante dos veces— se ve en el grupo, no en la fila.
   */
  dedupeKey(): string | undefined {
    return undefined;
  }

  // -------------------------------------------------------------------------
  // El grupo: el comprobante entero
  // -------------------------------------------------------------------------

  groupKey(data: Record<string, unknown>): string | undefined {
    const series = data.series as string | undefined;
    const correlative = data.correlative;
    if (!series || typeof correlative !== 'number') return undefined;
    return fiscalDocumentNumber(series, correlative);
  }

  async validateGroup(rows: GroupRow[]): Promise<RowIssues[]> {
    const head = rows[0]?.data;
    if (!head) return [];
    const shared: string[] = [];
    const warnings: string[] = [];
    const number = this.groupKey(head) ?? '';

    // 1. Una línea rota se lleva puesto al comprobante: no se importa a medias.
    if (rows.some((r) => r.errors.length > 0)) {
      shared.push(`Otra línea del comprobante ${number} tiene errores`);
    }

    // 2. La cabecera tiene que decir lo mismo en todas sus filas. Si no, no se sabe cuál
    //    de las dos versiones del documento es la que se está importando.
    for (const label of mismatchedHeaderLabels(
      rows.map((r) => r.data),
      HEADER_FIELDS,
    )) {
      shared.push(`Las líneas del comprobante ${number} no coinciden en ${label}`);
    }

    // 3. Las líneas tienen que sumar el total declarado (ver `totalTolerance`). Solo se
    //    comprueba cuando **todas** las líneas tienen cantidad y precio ya normalizados:
    //    con una línea rota la suma sobraría, y su error ya está en el punto 1.
    const priced = rows.filter(
      (r) => typeof r.data.qty === 'string' && typeof r.data.unitPricePen === 'string',
    );
    const declared = head.totalPen;
    if (priced.length === rows.length && typeof declared === 'string') {
      const mismatch = totalMismatch(
        rows.map((r) => ({
          qty: r.data.qty as string,
          unitPricePen: r.data.unitPricePen as string,
        })),
        declared,
      );
      if (mismatch) {
        shared.push(
          `Las líneas del comprobante ${number} suman ${mismatch.computed.toFixed(2)} y el archivo declara ${mismatch.declared.toFixed(2)}`,
        );
      }
    }

    // 4. Lo que ya existe con ese número: reimportación (RF-72), choque o nada.
    const existing = await this.prisma.fiscalDocument.findFirst({
      where: { number, archivedAt: null },
      select: { id: true, origin: true },
    });
    if (existing) {
      if (existing.origin !== FiscalDocumentOrigin.IMPORTED) {
        shared.push(`El comprobante ${number} lo emitió el ERP: no se puede reemplazar`);
      } else {
        const payments = await this.prisma.customerPayment.count({
          where: { documentId: existing.id, reversedAt: null },
        });
        if (payments > 0) {
          shared.push(
            `El comprobante ${number} ya tiene cobros registrados: revierte los cobros antes de reimportarlo`,
          );
        } else {
          warnings.push(`Reimportación: archiva la versión anterior de ${number}`);
        }
      }
    }

    // 5. Una nota de crédito necesita a su afectado ya en la base. Si viene en este mismo
    //    archivo, se importa primero ese y después la nota: son dos pasadas, y decirlo acá
    //    es más honesto que resolverlo por orden de filas y fallar recién al confirmar.
    const affected = asText(head.affectedNumber);
    if (head.docType === FiscalDocType.NOTA_CREDITO && affected) {
      const target = await this.prisma.fiscalDocument.findFirst({
        where: { number: affected, archivedAt: null },
        select: { id: true, docType: true },
      });
      if (!target) {
        shared.push(`El comprobante afectado ${affected} no existe: impórtalo antes que su nota`);
      } else if (target.docType === FiscalDocType.NOTA_CREDITO) {
        shared.push(`El documento afectado ${affected} es una nota de crédito`);
      }
    }

    return rows.map(() => ({ errors: [...shared], warnings: [...warnings] }));
  }

  async createGroup(
    tx: Prisma.TransactionClient,
    rows: Record<string, unknown>[],
    actorId: string,
  ): Promise<string> {
    const head = rows[0];
    if (!head) throw new BadRequestException('El comprobante no tiene líneas');
    const docType = head.docType as FiscalDocType;
    const affectedNumber = asText(head.affectedNumber);
    let affectedDocumentId: string | null = null;
    if (docType === FiscalDocType.NOTA_CREDITO && affectedNumber) {
      const target = await tx.fiscalDocument.findFirst({
        where: { number: affectedNumber, archivedAt: null },
        select: { id: true },
      });
      if (!target) {
        throw new BadRequestException(`El comprobante afectado ${affectedNumber} no existe`);
      }
      affectedDocumentId = target.id;
    }

    const lines: ImportedDocumentLine[] = rows.map((row) => ({
      productId: (row.productId as string | undefined) ?? null,
      description: row.description as string,
      qty: row.qty as string,
      unit: (row.unit as string) || DEFAULT_UNIT,
      unitPricePen: row.unitPricePen as string,
    }));

    return this.fiscalImport.importDocumentInTx(
      tx,
      {
        docType,
        series: head.series as string,
        correlative: head.correlative as number,
        issueDate: head.issueDate as string,
        customerId: head.customerId as string,
        paymentTerms: head.paymentTerms as PaymentTerms,
        dueDate: (head.dueDate as string) || null,
        affectedDocumentId,
        creditNoteReason: (head.creditNoteReason as CreditNoteReason) || null,
        notes: (head.notes as string) || null,
        lines,
      },
      actorId,
    );
  }
}
