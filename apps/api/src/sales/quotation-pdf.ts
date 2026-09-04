import PDFDocument from 'pdfkit';

/**
 * PDF de la cotización (D-068). Plantilla simple y deliberadamente austera: encabezado con
 * el nombre de la empresa, datos del cliente, tabla de líneas, totales y condiciones.
 *
 * Todos los montos vienen ya formateados desde el servicio, en soles y con su escala
 * (D-003/D-064): este archivo **no hace aritmética**, solo dibuja. Si empezara a calcular,
 * habría dos verdades sobre el total de una cotización.
 */

export interface QuotationPdfLine {
  description: string;
  qty: string;
  unit: string;
  unitPricePen: string;
  totalPen: string;
}

export interface QuotationPdfInput {
  code: string;
  issueDate: string;
  validUntil: string;
  customerName: string;
  customerDoc: string;
  customerAddress: string | null;
  notes: string | null;
  items: QuotationPdfLine[];
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
}

const MARGIN = 48;
const PAGE_WIDTH = 595.28; // A4 en puntos
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/** Columnas de la tabla, en puntos desde el margen izquierdo. */
const COLS = {
  description: { x: 0, width: 232 },
  qty: { x: 240, width: 60 },
  unit: { x: 304, width: 44 },
  price: { x: 352, width: 70 },
  total: { x: 426, width: 73 },
} as const;

/** `1234.5000` → `1 234.50`: dos decimales y separador de miles, como se lee un precio. */
function formatMoney(value: string): string {
  const [intPart = '0', decPart = '0000'] = value.split('.');
  const withSeparators = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${withSeparators}.${decPart.slice(0, 2).padEnd(2, '0')}`;
}

/** `100.000` → `100`, `12.500` → `12.5`: sin ceros de relleno a la derecha. */
function formatQty(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

export function buildQuotationPdf(input: QuotationPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: input.code } });
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
      .text('Transformación y venta de acero', MARGIN, doc.y + 2);
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#000')
      .text(`Cotización ${input.code}`, MARGIN, MARGIN, { width: CONTENT_WIDTH, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(9)
      .text(`Fecha: ${input.issueDate}`, MARGIN, MARGIN + 20, {
        width: CONTENT_WIDTH,
        align: 'right',
      });
    doc.text(`Válida hasta: ${input.validUntil}`, MARGIN, MARGIN + 33, {
      width: CONTENT_WIDTH,
      align: 'right',
    });

    // Cliente
    let y = MARGIN + 70;
    doc.font('Helvetica-Bold').fontSize(10).text('Cliente', MARGIN, y);
    y += 15;
    doc.font('Helvetica').fontSize(10).text(input.customerName, MARGIN, y);
    y += 13;
    doc.fontSize(9).fillColor('#555').text(input.customerDoc, MARGIN, y);
    if (input.customerAddress) {
      y += 12;
      doc.text(input.customerAddress, MARGIN, y, { width: CONTENT_WIDTH });
    }

    // Cabecera de la tabla
    y += 28;
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(9);
    doc.text('Descripción', MARGIN + COLS.description.x, y, { width: COLS.description.width });
    doc.text('Cantidad', MARGIN + COLS.qty.x, y, { width: COLS.qty.width, align: 'right' });
    doc.text('Unidad', MARGIN + COLS.unit.x, y, { width: COLS.unit.width });
    doc.text('P. unit.', MARGIN + COLS.price.x, y, { width: COLS.price.width, align: 'right' });
    doc.text('Importe', MARGIN + COLS.total.x, y, { width: COLS.total.width, align: 'right' });
    y += 14;
    doc
      .moveTo(MARGIN, y)
      .lineTo(MARGIN + CONTENT_WIDTH, y)
      .strokeColor('#999')
      .lineWidth(0.5)
      .stroke();
    y += 8;

    // Líneas
    doc.font('Helvetica').fontSize(9);
    for (const item of input.items) {
      const height = doc.heightOfString(item.description, { width: COLS.description.width });
      // Salto de página cuando la línea no entra; el pie de totales necesita ~110 puntos.
      if (y + height > doc.page.height - MARGIN - 110) {
        doc.addPage();
        y = MARGIN;
      }
      doc.text(item.description, MARGIN + COLS.description.x, y, {
        width: COLS.description.width,
      });
      doc.text(formatQty(item.qty), MARGIN + COLS.qty.x, y, {
        width: COLS.qty.width,
        align: 'right',
      });
      doc.text(item.unit, MARGIN + COLS.unit.x, y, { width: COLS.unit.width });
      doc.text(formatMoney(item.unitPricePen), MARGIN + COLS.price.x, y, {
        width: COLS.price.width,
        align: 'right',
      });
      doc.text(formatMoney(item.totalPen), MARGIN + COLS.total.x, y, {
        width: COLS.total.width,
        align: 'right',
      });
      y += Math.max(height, 12) + 6;
    }

    // Totales
    y += 6;
    doc
      .moveTo(MARGIN + COLS.price.x, y)
      .lineTo(MARGIN + CONTENT_WIDTH, y)
      .stroke();
    y += 8;
    const totalRows: [string, string][] = [
      ['Subtotal', input.subtotalPen],
      ['IGV (18%)', input.igvPen],
      ['Total', input.totalPen],
    ];
    for (const [label, value] of totalRows) {
      const bold = label === 'Total';
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9);
      doc.text(label, MARGIN + COLS.price.x - 60, y, {
        width: COLS.price.width + 60,
        align: 'right',
      });
      doc.text(`S/ ${formatMoney(value)}`, MARGIN + COLS.total.x, y, {
        width: COLS.total.width,
        align: 'right',
      });
      y += bold ? 18 : 14;
    }

    // Condiciones
    y += 16;
    doc.font('Helvetica-Bold').fontSize(9).text('Condiciones', MARGIN, y);
    y += 13;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#555')
      .text(
        `Precios expresados en soles (PEN), sin incluir IGV en el detalle de líneas. Cotización válida hasta el ${input.validUntil}. La confirmación de esta cotización genera el pedido y reserva el material correspondiente.`,
        MARGIN,
        y,
        { width: CONTENT_WIDTH },
      );
    if (input.notes) {
      doc.moveDown(0.6).text(input.notes, { width: CONTENT_WIDTH });
    }

    doc.end();
  });
}
