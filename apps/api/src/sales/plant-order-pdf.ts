import PDFDocument from 'pdfkit';

/**
 * Hoja de planta del pedido (D-149).
 *
 * **No es la cotización sin precios.** Es el papel que baja al taller, así que lleva
 * exactamente lo que hace falta para rolar —producto, metros a producir, largos y medidas
 * del material— y **ningún importe**: el operario no tiene por qué ver el precio al que se
 * vendió, y una hoja con precios circulando por la planta es la forma más barata de que se
 * enteren todos.
 *
 * Como `quotation-pdf.ts`, este archivo **no hace aritmética**: los metros y los largos
 * vienen ya formateados desde el servicio (D-003). Si empezara a calcular, habría dos
 * verdades sobre cuántos metros hay que producir.
 */

export interface PlantOrderPdfLine {
  lineNumber: number;
  productSku: string;
  productName: string;
  /** Metros lineales a producir, o la cantidad de planchas cuando la unidad son piezas. */
  quantity: string;
  unitLabel: string;
  /** `10 × 4.20 m`, vacío cuando la línea no lleva subítems de largo. */
  pieces: string;
  /** `0.50 mm · 1 000 mm · Rojo teja`, lo que decide qué bobina se monta (D-086). */
  measures: string;
}

export interface PlantOrderPdfInput {
  code: string;
  issueDate: string;
  promisedDeliveryDate: string | null;
  customerName: string;
  customerDoc: string;
  priorityReason: string | null;
  notes: string | null;
  lines: PlantOrderPdfLine[];
}

const MARGIN = 48;
const PAGE_WIDTH = 595.28; // A4 en puntos
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/** Columnas de la tabla, en puntos desde el margen izquierdo. */
const COLS = {
  product: { x: 0, width: 150 },
  quantity: { x: 158, width: 74 },
  pieces: { x: 240, width: 130 },
  measures: { x: 378, width: 121 },
} as const;

export function buildPlantOrderPdf(input: PlantOrderPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      info: { Title: `${input.code} — planta` },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);

    // Encabezado
    doc.font('Helvetica-Bold').fontSize(18).text('AYR Steel', MARGIN, MARGIN);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#555')
      .text('Hoja de planta — sin valor comercial', MARGIN, doc.y + 2);
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#000')
      .text(`Pedido ${input.code}`, MARGIN, MARGIN, { width: CONTENT_WIDTH, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(9)
      .text(`Fecha: ${input.issueDate}`, MARGIN, MARGIN + 20, {
        width: CONTENT_WIDTH,
        align: 'right',
      });
    doc.text(
      `Entrega: ${input.promisedDeliveryDate ?? 'sin fecha prometida'}`,
      MARGIN,
      MARGIN + 33,
      { width: CONTENT_WIDTH, align: 'right' },
    );
    if (input.priorityReason !== null) {
      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor('#b91c1c')
        .text('PRIORIDAD', MARGIN, MARGIN + 46, { width: CONTENT_WIDTH, align: 'right' })
        .fillColor('#000');
    }

    // Cliente
    let y = MARGIN + 70;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text('Cliente', MARGIN, y);
    y += 15;
    doc.font('Helvetica').fontSize(10).text(input.customerName, MARGIN, y);
    y += 13;
    doc.fontSize(9).fillColor('#555').text(input.customerDoc, MARGIN, y);
    if (input.priorityReason !== null) {
      y += 12;
      doc.text(`Prioridad: ${input.priorityReason}`, MARGIN, y, { width: CONTENT_WIDTH });
    }

    // Cabecera de la tabla
    y += 28;
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(9);
    doc.text('Producto', MARGIN + COLS.product.x, y, { width: COLS.product.width });
    doc.text('A producir', MARGIN + COLS.quantity.x, y, {
      width: COLS.quantity.width,
      align: 'right',
    });
    doc.text('Largos', MARGIN + COLS.pieces.x, y, { width: COLS.pieces.width });
    doc.text('Medidas', MARGIN + COLS.measures.x, y, { width: COLS.measures.width });
    y += 14;
    doc
      .moveTo(MARGIN, y)
      .lineTo(MARGIN + CONTENT_WIDTH, y)
      .strokeColor('#999')
      .lineWidth(0.5)
      .stroke();
    y += 8;

    for (const line of input.lines) {
      doc.font('Helvetica').fontSize(9);
      const heights = [
        doc.heightOfString(`${line.productSku}\n${line.productName}`, {
          width: COLS.product.width,
        }),
        doc.heightOfString(line.pieces, { width: COLS.pieces.width }),
        doc.heightOfString(line.measures, { width: COLS.measures.width }),
      ];
      const height = Math.max(...heights, 12);
      // Salto de página cuando la fila no entra; el pie deja ~90 puntos para las firmas.
      if (y + height > doc.page.height - MARGIN - 90) {
        doc.addPage();
        y = MARGIN;
      }

      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(line.productSku, MARGIN + COLS.product.x, y, {
          width: COLS.product.width,
        });
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#555')
        .text(line.productName, MARGIN + COLS.product.x, doc.y, { width: COLS.product.width });
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(11);
      doc.text(`${line.quantity} ${line.unitLabel}`, MARGIN + COLS.quantity.x, y, {
        width: COLS.quantity.width,
        align: 'right',
      });
      doc.font('Helvetica').fontSize(9);
      doc.text(line.pieces, MARGIN + COLS.pieces.x, y, { width: COLS.pieces.width });
      doc.fillColor('#555').text(line.measures, MARGIN + COLS.measures.x, y, {
        width: COLS.measures.width,
      });
      doc.fillColor('#000');

      y += height + 10;
      doc
        .moveTo(MARGIN, y - 5)
        .lineTo(MARGIN + CONTENT_WIDTH, y - 5)
        .strokeColor('#e5e5e5')
        .stroke();
    }

    if (input.notes) {
      y += 10;
      doc.font('Helvetica-Bold').fontSize(9).text('Observaciones', MARGIN, y);
      y += 13;
      doc.font('Helvetica').fontSize(9).text(input.notes, MARGIN, y, { width: CONTENT_WIDTH });
      y = doc.y;
    }

    // Pie: lo que la hoja vuelve con algo escrito a mano.
    y = Math.max(y + 24, doc.page.height - MARGIN - 60);
    doc.font('Helvetica').fontSize(8).fillColor('#555');
    doc.text('Produjo: ______________________', MARGIN, y);
    doc.text('Fecha: ____________', MARGIN + 220, y);
    doc.text('Conformidad: ______________________', MARGIN + 330, y);

    doc.end();
  });
}
