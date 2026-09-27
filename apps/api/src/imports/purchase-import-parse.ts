import { BadRequestException } from '@nestjs/common';
import {
  MAX_PURCHASE_IMPORT_ROWS,
  PURCHASE_IMPORT_COLUMNS,
  purchaseDocTypeOf,
  purchaseTypeOf,
  splitDocumentNumber,
  type PurchaseImportDocumentInput,
  type PurchaseImportLineInput,
} from '@ayr/shared';
import { getField, parseCalendarDate, pickRawValue, type ImportColumn } from './parse-spreadsheet';

/**
 * **Lectura de la planilla de compras (D-351), sin tocar la base.** Una fila es una línea; las
 * filas se agrupan en comprobantes por RUC + tipo de comprobante + serie-número. Los textos
 * quedan como vienen (el validador los revisa todos, también los que el usuario edite después);
 * solo se normaliza lo que no cambia de significado: la fecha `DD/MM/AAAA` a ISO y la serie y el
 * número separados.
 */

const COLUMNS = Object.values(PURCHASE_IMPORT_COLUMNS) as readonly ImportColumn[];

/** Los campos de cabecera que tienen que repetirse igual en todas las filas del comprobante. */
const HEADER_FIELDS = [
  'type',
  'businessLine',
  'issueDate',
  'currency',
  'exchangeRate',
  'paymentTerms',
  'creditDays',
  'serviceKind',
  'igvRate',
  'documentTotal',
] as const;

export interface ParsedPurchaseFile {
  documents: PurchaseImportDocumentInput[];
  /**
   * Por comprobante, lo que solo se ve en el archivo y no en el comprobante armado: filas que no
   * repiten la cabecera, bobinas con KG y CANTIDAD distintos. Son avisos del preview, que dicen qué se tomó.
   */
  headerConflicts: Map<string, string[]>;
  rows: number;
}

export function assertPurchaseColumns(first: Record<string, unknown>): void {
  const missing = COLUMNS.filter(
    (c) => c.required && pickRawValue(first, c.header) === undefined,
  ).map((c) => c.header);
  if (missing.length > 0) {
    throw new BadRequestException(
      `El archivo no tiene ${missing.length === 1 ? 'la columna' : 'las columnas'} ${missing.join(', ')}. ` +
        'Usa la plantilla de importación de compras sin cambiarle los encabezados.',
    );
  }
}

/** `03/08/2026` → `2026-08-03`; lo que no es una fecha válida queda como vino. */
export function issueDateOf(raw: string): string {
  return parseCalendarDate(raw) ?? raw;
}

/**
 * La clave del comprobante: RUC + tipo + serie-número, en la forma que se tipeó (mayúsculas y sin
 * espacios). Dos filas con la misma clave son líneas del mismo papel.
 */
export function documentKeyOf(ruc: string, docType: string, document: string): string {
  const doc = purchaseDocTypeOf(docType) ?? docType.trim().toUpperCase();
  return `${ruc.trim()}|${doc}|${document.trim().toUpperCase().replace(/\s/g, '')}`;
}

export function parsePurchaseRows(raws: readonly Record<string, unknown>[]): ParsedPurchaseFile {
  if (raws.length > MAX_PURCHASE_IMPORT_ROWS) {
    throw new BadRequestException(
      `Máximo ${String(MAX_PURCHASE_IMPORT_ROWS)} filas por importación: parte el archivo`,
    );
  }
  const first = raws[0];
  if (!first) throw new BadRequestException('El archivo no tiene filas de datos');
  assertPurchaseColumns(first);

  const documents = new Map<string, PurchaseImportDocumentInput>();
  const headerConflicts = new Map<string, string[]>();
  raws.forEach((raw, index) => {
    const field = (key: keyof typeof PURCHASE_IMPORT_COLUMNS) =>
      getField(raw, PURCHASE_IMPORT_COLUMNS[key]);
    // La fila 1 es el encabezado: la primera fila de datos es la 2, como la ve el usuario.
    const rowNumber = index + 2;
    const documentText = field('document');
    const split = splitDocumentNumber(documentText);
    const key = documentKeyOf(field('supplierRuc'), field('docType'), documentText);
    const header = {
      type: field('type'),
      businessLine: field('businessLine'),
      issueDate: issueDateOf(field('issueDate')),
      currency: field('currency'),
      exchangeRate: field('exchangeRate'),
      paymentTerms: field('paymentTerms'),
      creditDays: field('creditDays'),
      serviceKind: field('serviceKind'),
      igvRate: field('igvRate'),
      documentTotal: field('documentTotal'),
    };
    const isCoil = purchaseTypeOf(header.type) === 'COIL';
    const line = lineOf(raw, rowNumber, isCoil);
    const report = (message: string) => {
      const known = headerConflicts.get(key) ?? [];
      if (!known.includes(message)) headerConflicts.set(key, [...known, message]);
    };
    if (isCoil && kgConflict(raw)) {
      report(
        `Fila ${String(rowNumber)}: KG y CANTIDAD no coinciden; en una bobina la cantidad son los kilos: se tomó KG`,
      );
    }

    const existing = documents.get(key);
    if (existing) {
      const conflicts = HEADER_FIELDS.filter((f) => existing[f] !== header[f]);
      if (conflicts.length > 0) {
        const labels = conflicts.map((f) => PURCHASE_IMPORT_COLUMNS[f].header).join(', ');
        report(
          `Fila ${String(rowNumber)}: trae ${labels} distinto de la primera fila del comprobante: se tomó el de la primera fila`,
        );
      }
      // Las observaciones de varias filas se juntan, sin repetir.
      const notes = field('notes');
      if (notes !== '' && !existing.notes.includes(notes)) {
        existing.notes =
          existing.notes === '' ? notes : `${existing.notes} · ${notes}`.slice(0, 500);
      }
      existing.lines.push(line);
      return;
    }
    documents.set(key, {
      key,
      ...header,
      docType: field('docType'),
      series: split?.series ?? documentText,
      number: split?.number ?? '',
      supplierRuc: field('supplierRuc'),
      supplierId: null,
      newSupplierCode: null,
      notes: field('notes'),
      confirmedNotInitialLoad: false,
      lines: [line],
    });
  });
  return { documents: [...documents.values()], headerConflicts, rows: raws.length };
}

function lineOf(
  raw: Record<string, unknown>,
  rowNumber: number,
  isCoil: boolean,
): PurchaseImportLineInput {
  const field = (key: keyof typeof PURCHASE_IMPORT_COLUMNS) =>
    getField(raw, PURCHASE_IMPORT_COLUMNS[key]);
  // En una bobina la cantidad **son los kilos**: la columna KG manda y CANTIDAD solo se usa si KG
  // vino vacía (una planilla que ya los puso ahí). Si vienen las dos y difieren, lo dice el
  // validador (ver `kgConflict`).
  const kg = field('kg');
  const qty = field('qty');
  return {
    rowNumber,
    sku: field('sku'),
    productId: null,
    description: field('description'),
    qty: isCoil ? kg || qty : qty,
    unit: field('unit'),
    unitPrice: field('unitPrice'),
    finishCode: field('finishCode'),
    finishId: null,
    color: field('color'),
    thicknessMm: field('thicknessMm'),
    widthMm: field('widthMm'),
    externalCode: field('externalCode'),
  };
}

/** Una bobina con KG y CANTIDAD que no dicen lo mismo: no se elige una en silencio. */
export function kgConflict(raw: Record<string, unknown>): boolean {
  const kg = getField(raw, PURCHASE_IMPORT_COLUMNS.kg);
  const qty = getField(raw, PURCHASE_IMPORT_COLUMNS.qty);
  return kg !== '' && qty !== '' && kg.replace(',', '.') !== qty.replace(',', '.');
}
