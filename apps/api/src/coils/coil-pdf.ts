import PDFDocument from 'pdfkit';
import {
  BUSINESS_LINE_LABELS,
  COIL_STATUS_LABELS,
  INVENTORY_MOVEMENT_TYPE_LABELS,
  INVENTORY_REF_TYPE_LABELS,
  type BusinessLine,
  type CoilConsumptionDto,
  type CoilDto,
  type CoilStatus,
  type InventoryMovementDto,
} from '@ayr/shared';

/**
 * Reporte de bobinas en PDF (T6, D-173). Mismo criterio que `plant-order-pdf.ts` (D-149):
 * es de solo lectura y regenerable, así que se arma al vuelo con `pdfkit` y **no** se
 * persiste en R2 (a diferencia del PDF de la cotización, D-068, que es un documento que
 * sale de la empresa y por eso queda congelado). Este archivo tampoco hace aritmética: los
 * números ya vienen formateados desde `CoilsService` (D-003).
 */

const MARGIN = 48;
const PAGE_WIDTH = 595.28; // A4 en puntos
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function newDoc(title: string): PDFKit.PDFDocument {
  return new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: title } });
}

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
  });
}

function header(doc: PDFKit.PDFDocument, subtitle: string): void {
  doc.font('Helvetica-Bold').fontSize(18).text('AYR Steel', MARGIN, MARGIN);
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#555')
    .text(subtitle, MARGIN, doc.y + 2);
  doc.fillColor('#000');
}

export interface CoilPdfInput {
  code: string;
  typeKey: string;
  businessLine: BusinessLine;
  supplierName: string;
  finishLabel: string;
  colorName: string | null;
  widthMm: string;
  thicknessMm: string;
  status: CoilStatus;
  weightKg: string;
  availableKg: string;
  avgCostPen: string;
  notes: string | null;
  operationDate: string;
  consumptions: CoilConsumptionDto[];
  movements: InventoryMovementDto[];
}

/** Detalle de una sola bobina: identificación, saldo y sus dos historiales. */
export function buildCoilPdf(input: CoilPdfInput): Promise<Buffer> {
  const doc = newDoc(`${input.code} — bobina`);
  const result = collect(doc);

  header(doc, 'Reporte de bobina');
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(input.code, MARGIN, MARGIN, { width: CONTENT_WIDTH, align: 'right' });
  doc
    .font('Helvetica')
    .fontSize(9)
    .text(`Alta: ${input.operationDate}`, MARGIN, MARGIN + 20, {
      width: CONTENT_WIDTH,
      align: 'right',
    });

  let y = MARGIN + 60;
  doc.font('Helvetica-Bold').fontSize(10).text('Material', MARGIN, y);
  y += 15;
  doc
    .font('Helvetica')
    .fontSize(9)
    .text(
      `${input.finishLabel} · ${input.thicknessMm} mm · ${input.widthMm} mm de ancho` +
        (input.colorName ? ` · ${input.colorName}` : ''),
      MARGIN,
      y,
      { width: CONTENT_WIDTH },
    );
  y += 13;
  doc.text(
    `${BUSINESS_LINE_LABELS[input.businessLine]} · ${input.supplierName} · ${COIL_STATUS_LABELS[input.status]}`,
    MARGIN,
    y,
    { width: CONTENT_WIDTH },
  );

  y += 26;
  doc.font('Helvetica-Bold').fontSize(10).text('Saldo', MARGIN, y);
  y += 15;
  doc
    .font('Helvetica')
    .fontSize(9)
    .text(
      `Peso de alta: ${input.weightKg} kg · Disponible: ${input.availableKg} kg · Costo promedio: S/ ${input.avgCostPen}/kg`,
      MARGIN,
      y,
      { width: CONTENT_WIDTH },
    );

  if (input.notes) {
    y += 20;
    doc.font('Helvetica-Bold').fontSize(9).text('Observaciones', MARGIN, y);
    y += 13;
    doc.font('Helvetica').fontSize(9).text(input.notes, MARGIN, y, { width: CONTENT_WIDTH });
    y = doc.y;
  }

  y += 24;
  y = table(
    doc,
    y,
    'Órdenes de producción',
    ['Orden', 'Producto', 'Pedido', 'Asignado (kg)', 'Consumido (kg)'],
    [90, 110, 110, 90, 90],
    input.consumptions.map((c) => [
      c.productionOrderCode,
      c.productSku,
      c.salesOrderCode ?? 'Sin pedido',
      c.assignedKg,
      c.consumedKg,
    ]),
    'Ninguna orden de producción montó esta bobina todavía.',
  );

  y += 24;
  table(
    doc,
    y,
    'Kardex',
    ['Fecha', 'Movimiento', 'Origen', 'Cantidad', 'Saldo'],
    [70, 90, 110, 100, 90],
    input.movements.map((m) => [
      m.operationDate,
      INVENTORY_MOVEMENT_TYPE_LABELS[m.type],
      INVENTORY_REF_TYPE_LABELS[m.refType],
      m.type === 'ADJUST' ? '—' : m.qty,
      m.balanceQty ?? '—',
    ]),
    'Sin movimientos.',
  );

  doc.end();
  return result;
}

export interface CoilsReportPdfInput {
  generatedAt: string;
  totalMatched: number;
  rows: CoilDto[];
}

/** Bobinas del conjunto filtrado actual de la lista (D-173), en una sola tabla. */
export function buildCoilsReportPdf(input: CoilsReportPdfInput): Promise<Buffer> {
  const doc = newDoc('Reporte de bobinas');
  const result = collect(doc);

  header(doc, `Reporte de bobinas — generado ${input.generatedAt}`);
  let y = MARGIN + 40;
  if (input.totalMatched > input.rows.length) {
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#b91c1c')
      .text(
        `Mostrando las primeras ${String(input.rows.length)} de ${String(input.totalMatched)} bobinas que cumplen el filtro. Acota la búsqueda para ver el resto.`,
        MARGIN,
        y,
        { width: CONTENT_WIDTH },
      )
      .fillColor('#000');
    y = doc.y + 10;
  }

  table(
    doc,
    y,
    null,
    ['Código', 'Línea', 'Color', 'Ancho', 'Disponible (kg)', 'Estado'],
    [165, 80, 60, 55, 80, 55],
    input.rows.map((c) => [
      c.code,
      BUSINESS_LINE_LABELS[c.businessLine],
      c.colorName ?? '—',
      `${c.widthMm} mm`,
      c.availableKg,
      COIL_STATUS_LABELS[c.status],
    ]),
    'No hay bobinas que coincidan con los filtros.',
  );

  doc.end();
  return result;
}

/** Tabla simple de ancho fijo por columna, con salto de página. Devuelve el `y` final. */
function table(
  doc: PDFKit.PDFDocument,
  startY: number,
  title: string | null,
  headers: string[],
  widths: number[],
  rows: string[][],
  emptyLabel: string,
): number {
  let y = startY;
  if (y > doc.page.height - MARGIN - 80) {
    doc.addPage();
    y = MARGIN;
  }
  if (title) {
    doc.font('Helvetica-Bold').fontSize(10).text(title, MARGIN, y);
    y += 16;
  }
  y = drawHeaderRow(doc, y, headers, widths);

  if (rows.length === 0) {
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(emptyLabel, MARGIN, y);
    doc.fillColor('#000');
    return doc.y;
  }

  // Una línea por fila, con "…" si no entra: un código o un SKU sin espacios no tiene
  // dónde partirse, y sin `ellipsis` pdfkit no lo corta — sigue escribiendo derecho
  // encima de la columna siguiente en vez de respetar el ancho declarado.
  const lineHeight = doc.currentLineHeight();
  for (const row of rows) {
    if (y > doc.page.height - MARGIN - 20) {
      doc.addPage();
      y = MARGIN;
      // El header viaja con la tabla: sin esto, una lista que cruza de página deja
      // la mayoría de sus filas sin decir qué columna es cuál.
      y = drawHeaderRow(doc, y, headers, widths);
    }
    doc.font('Helvetica').fontSize(8);
    let x = MARGIN;
    row.forEach((cell, i) => {
      const w = widths[i] ?? 80;
      doc.text(cell, x, y, { width: w, height: lineHeight, ellipsis: true });
      x += w;
    });
    y += lineHeight + 6;
  }
  return y;
}

/** Fila de encabezados + la línea separadora debajo. Devuelve el `y` donde empieza el cuerpo. */
function drawHeaderRow(
  doc: PDFKit.PDFDocument,
  startY: number,
  headers: string[],
  widths: number[],
): number {
  let y = startY;
  doc.font('Helvetica-Bold').fontSize(8);
  let x = MARGIN;
  headers.forEach((h, i) => {
    doc.text(h, x, y, { width: widths[i] ?? 80 });
    x += widths[i] ?? 80;
  });
  y += 12;
  doc
    .moveTo(MARGIN, y)
    .lineTo(MARGIN + CONTENT_WIDTH, y)
    .strokeColor('#999')
    .lineWidth(0.5)
    .stroke();
  return y + 6;
}
