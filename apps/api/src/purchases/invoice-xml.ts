import { BadRequestException } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';
import { Currency, Decimal, toDecimal, toFixedString, type PurchaseDocType } from '@ayr/shared';

/**
 * Parseo del XML UBL 2.1 de la factura electrónica del proveedor (RF-11).
 * Las rutas y los catálogos SUNAT están documentados en `docs/referencias/ubl21-factura.md`.
 *
 * Reglas que se respetan aquí:
 * - Todo importe llega como **string** y se convierte con `Decimal` (D-003); el parser
 *   tiene `parseTagValue`/`parseAttributeValue` en `false` justamente para eso.
 * - `processEntities: false` desactiva la expansión de entidades (XXE / billion laughs).
 * - Los prefijos de namespace se aplanan (`removeNSPrefix`), así que se navega por
 *   nombre local: `cac:InvoiceLine` se lee como `InvoiceLine`.
 */

/** Tamaño máximo del XML aceptado. Una factura real no llega ni a 1 MB. */
const MAX_XML_BYTES = 2 * 1024 * 1024;

/** Catálogo 01 de SUNAT → tipo de comprobante del ERP. */
const DOC_TYPE_BY_CATALOG_01: Record<string, PurchaseDocType> = {
  '01': 'FACTURA',
  '03': 'BOLETA',
  '07': 'NOTA_CREDITO',
  '08': 'NOTA_DEBITO',
};

/** Elementos raíz posibles y el nombre de su nodo de línea y de cantidad. */
const ROOTS = [
  { root: 'Invoice', line: 'InvoiceLine', qty: 'InvoicedQuantity' },
  { root: 'CreditNote', line: 'CreditNoteLine', qty: 'CreditedQuantity' },
  { root: 'DebitNote', line: 'DebitNoteLine', qty: 'DebitedQuantity' },
] as const;

export interface ParsedInvoiceLine {
  lineNumber: number;
  description: string;
  sellerItemCode: string | null;
  qty: string;
  unit: string;
  /** Precio unitario SIN IGV (D-038). */
  unitPrice: string;
  subtotal: string;
  igv: string;
}

export interface ParsedInvoice {
  supplierDocNumber: string;
  supplierName: string;
  docType: PurchaseDocType;
  series: string;
  number: string;
  issueDate: string;
  dueDate: string | null;
  currency: Currency;
  paymentTerms: 'CONTADO' | 'CREDITO';
  creditDays: number | null;
  igvRate: string;
  subtotal: string;
  igv: string;
  total: string;
  lines: ParsedInvoiceLine[];
  /** Avisos para que el usuario revise antes de confirmar (RF-11 es prellenado, no alta ciega). */
  warnings: string[];
}

type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  // Seguridad: sin expansión de entidades ni DTD.
  processEntities: false,
  // Precisión (D-003): todo importe llega como string, nunca como `number` de JS.
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Los prefijos de namespace son alias del documento; se navega por nombre local.
  removeNSPrefix: true,
  trimValues: true,
  allowBooleanAttributes: false,
});

export function parseInvoiceXml(buffer: Buffer): ParsedInvoice {
  if (buffer.length === 0) throw new BadRequestException('El archivo XML está vacío');
  if (buffer.length > MAX_XML_BYTES) {
    throw new BadRequestException('El XML supera el tamaño máximo permitido (2 MB)');
  }
  if (buffer.subarray(0, 2).toString('latin1') === 'PK') {
    throw new BadRequestException(
      'El archivo es un ZIP. Extrae el XML del comprobante y súbelo suelto',
    );
  }

  const xml = buffer.toString('utf8');
  if (/<!DOCTYPE/i.test(xml)) {
    throw new BadRequestException('El XML declara un DOCTYPE y no se procesa por seguridad');
  }

  let parsed: XmlNode;
  try {
    parsed = parser.parse(xml) as XmlNode;
  } catch {
    throw new BadRequestException('El archivo no es un XML válido');
  }

  const shape = ROOTS.find((r) => isNode(parsed[r.root]));
  if (!shape) {
    throw new BadRequestException(
      'El XML no es un comprobante UBL 2.1 (no tiene Invoice, CreditNote ni DebitNote)',
    );
  }
  const doc = parsed[shape.root] as XmlNode;
  const warnings: string[] = [];

  const { series, number } = splitDocumentId(text(doc.ID));
  const docTypeCode = text(doc.InvoiceTypeCode) || defaultTypeCodeFor(shape.root);
  const docType = DOC_TYPE_BY_CATALOG_01[docTypeCode];
  if (!docType) {
    throw new BadRequestException(
      `Tipo de comprobante ${docTypeCode || 'desconocido'} no soportado (catálogo 01 de SUNAT)`,
    );
  }

  const currencyCode = text(doc.DocumentCurrencyCode);
  if (currencyCode !== Currency.PEN && currencyCode !== Currency.USD) {
    throw new BadRequestException(`Moneda ${currencyCode || 'desconocida'} no soportada (PEN/USD)`);
  }
  const currency: Currency = currencyCode;

  const supplierParty = pick(doc, ['AccountingSupplierParty', 'Party']);
  const supplierDocNumber = text(pick(supplierParty, ['PartyIdentification', 'ID']));
  const supplierName =
    text(pick(supplierParty, ['PartyLegalEntity', 'RegistrationName'])) ||
    text(pick(supplierParty, ['PartyName', 'Name']));
  if (!supplierDocNumber) warnings.push('El XML no trae el RUC del emisor: elige el proveedor a mano');

  const issueDate = text(doc.IssueDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    throw new BadRequestException('El XML no trae una fecha de emisión válida');
  }

  const payment = readPaymentTerms(doc, text(doc.DueDate));
  const creditDays =
    payment.terms === 'CREDITO' && payment.dueDate
      ? daysBetween(issueDate, payment.dueDate)
      : null;
  if (payment.terms === 'CREDITO' && creditDays === null) {
    warnings.push('La factura es al crédito pero no trae fecha de vencimiento: indícala a mano');
  }

  const lines = readLines(doc, shape.line, shape.qty);
  if (lines.length === 0) throw new BadRequestException('El XML no tiene líneas de detalle');

  const monetary = asNode(doc.LegalMonetaryTotal);
  const subtotal = decimalOr(
    text(monetary?.LineExtensionAmount),
    lines.reduce((acc, l) => acc.plus(toDecimal(l.subtotal)), new Decimal(0)),
  );
  const igv = decimalOr(
    text(firstNode(doc.TaxTotal)?.TaxAmount),
    lines.reduce((acc, l) => acc.plus(toDecimal(l.igv)), new Decimal(0)),
  );
  const total = decimalOr(text(monetary?.PayableAmount), subtotal.plus(igv));

  if (!total.minus(subtotal.plus(igv)).abs().lte(new Decimal('0.05'))) {
    warnings.push('El total del XML no cuadra con la suma de valor de venta más IGV: revisa el detalle');
  }

  return {
    supplierDocNumber,
    supplierName,
    docType,
    series,
    number,
    issueDate,
    dueDate: payment.dueDate,
    currency,
    paymentTerms: payment.terms,
    creditDays,
    igvRate: inferIgvRate(doc, subtotal, igv),
    subtotal: toFixedString(subtotal, 'MONEY'),
    igv: toFixedString(igv, 'MONEY'),
    total: toFixedString(total, 'MONEY'),
    lines,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Lectura de secciones
// ---------------------------------------------------------------------------

function readLines(doc: XmlNode, lineTag: string, qtyTag: string): ParsedInvoiceLine[] {
  return asArray(doc[lineTag]).map((raw, index) => {
    const line = asNode(raw) ?? {};
    const qtyNode = line[qtyTag];
    const qty = text(qtyNode) || '0';
    const unit = attr(qtyNode, 'unitCode') || 'NIU';
    const subtotal = decimalOr(text(line.LineExtensionAmount), new Decimal(0));
    const lineIgv = decimalOr(text(firstNode(line.TaxTotal)?.TaxAmount), new Decimal(0));
    const priceAmount = text(pick(line, ['Price', 'PriceAmount']));
    const qtyDecimal = toDecimal(qty);
    // Si el XML no trae precio unitario, se deriva del valor de venta de la línea.
    const unitPrice =
      priceAmount || (qtyDecimal.gt(0) ? subtotal.div(qtyDecimal).toFixed(6) : '0');

    return {
      lineNumber: Number(text(line.ID)) || index + 1,
      description: text(pick(line, ['Item', 'Description'])),
      sellerItemCode: text(pick(line, ['Item', 'SellersItemIdentification', 'ID'])) || null,
      qty: toFixedString(qty, 'KG'),
      unit,
      unitPrice: toFixedString(unitPrice, 'MONEY'),
      subtotal: toFixedString(subtotal, 'MONEY'),
      igv: toFixedString(lineIgv, 'MONEY'),
    };
  });
}

/**
 * Contado vs. crédito (§2.4 de la referencia). En crédito la fecha real de vencimiento
 * está en el bloque `Cuota001`, no siempre en el `DueDate` de cabecera.
 */
function readPaymentTerms(
  doc: XmlNode,
  headerDueDate: string,
): { terms: 'CONTADO' | 'CREDITO'; dueDate: string | null } {
  const blocks = asArray(doc.PaymentTerms).map((b) => asNode(b) ?? {});
  const isCredit = blocks.some((b) => text(b.PaymentMeansID).toUpperCase() === 'CREDITO');
  if (!isCredit) {
    const hasContado = blocks.some((b) => text(b.PaymentMeansID).toUpperCase() === 'CONTADO');
    // Sin bloques de forma de pago, un DueDate posterior a la emisión igual implica crédito.
    if (hasContado || !headerDueDate) return { terms: 'CONTADO', dueDate: null };
  }

  const installmentDates = blocks
    .filter((b) => /^CUOTA\d+$/i.test(text(b.PaymentMeansID)))
    .map((b) => text(b.PaymentDueDate))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  const dueDate =
    installmentDates[0] ??
    (/^\d{4}-\d{2}-\d{2}$/.test(headerDueDate) ? headerDueDate : null);
  return { terms: isCredit || dueDate ? 'CREDITO' : 'CONTADO', dueDate };
}

/**
 * Porcentaje de IGV: primero el `Percent` declarado en la primera línea; si no está,
 * se deriva de igv/subtotal; si tampoco se puede, 18 (tasa vigente en Perú).
 */
function inferIgvRate(doc: XmlNode, subtotal: Decimal, igv: Decimal): string {
  for (const tag of ['InvoiceLine', 'CreditNoteLine', 'DebitNoteLine']) {
    for (const raw of asArray(doc[tag])) {
      const percent = text(
        pick(asNode(raw) ?? {}, ['TaxTotal', 'TaxSubtotal', 'TaxCategory', 'Percent']),
      );
      if (percent) return toFixedString(percent, 'RATE');
    }
  }
  if (subtotal.gt(0)) return toFixedString(igv.div(subtotal).times(100), 'RATE');
  return '18.0000';
}

// ---------------------------------------------------------------------------
// Utilidades de navegación del árbol
// ---------------------------------------------------------------------------

function isNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNode(value: unknown): XmlNode | undefined {
  if (Array.isArray(value)) return isNode(value[0]) ? value[0] : undefined;
  return isNode(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function firstNode(value: unknown): XmlNode | undefined {
  return asNode(value);
}

/** Texto de un nodo, venga como string suelto o como objeto con atributos (`#text`). */
function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return text(value[0]);
  if (isNode(value)) {
    const raw = value['#text'];
    return typeof raw === 'string' ? raw.trim() : '';
  }
  return '';
}

function attr(value: unknown, name: string): string {
  const node = asNode(value);
  const raw = node?.[`@_${name}`];
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Navega una ruta de nombres locales, tomando el primer nodo si hay repetidos. */
function pick(node: unknown, path: string[]): unknown {
  let current: unknown = node;
  for (const step of path) {
    const asObject = asNode(current);
    if (!asObject) return undefined;
    current = asObject[step];
  }
  return current;
}

function decimalOr(value: string, fallback: Decimal): Decimal {
  if (!value || !/^-?\d+(\.\d+)?$/.test(value)) return fallback;
  return toDecimal(value);
}

/** `F001-00000123` → serie `F001`, número `123` (sin ceros a la izquierda). */
function splitDocumentId(id: string): { series: string; number: string } {
  const [series, ...rest] = id.split('-');
  const number = rest.join('-').replace(/\D/g, '');
  if (!series || !number) {
    throw new BadRequestException(`El XML no trae una serie-número válida (leído: "${id}")`);
  }
  return { series: series.toUpperCase(), number: String(Number(number)) };
}

function daysBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(`${fromIso}T00:00:00.000Z`);
  const to = Date.parse(`${toIso}T00:00:00.000Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  const days = Math.round((to - from) / 86_400_000);
  return days > 0 ? days : null;
}

function defaultTypeCodeFor(root: string): string {
  if (root === 'CreditNote') return '07';
  if (root === 'DebitNote') return '08';
  return '';
}
