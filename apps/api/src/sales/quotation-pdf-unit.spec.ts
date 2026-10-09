import { buildQuotationPdf, type QuotationPdfInput } from './quotation-pdf';

/**
 * D-579: la cotización no es un documento SUNAT. Su PDF muestra la unidad como en el resto de la
 * app («und», «m», «kg»), no el código del catálogo 03 que guarda la línea («NIU», «MTR»).
 *
 * Se reemplaza `pdfkit` por un documento falso que anota cada `text()`: el PDF real va comprimido
 * y no se puede leer el texto sin un parser.
 */
const written: string[] = [];

jest.mock('pdfkit', () => {
  return jest.fn().mockImplementation(() => {
    const listeners: Record<string, (() => void)[]> = {};
    const doc: Record<string, unknown> = {
      y: 0,
      page: { height: 842 },
      on: (event: string, cb: () => void) => {
        (listeners[event] ??= []).push(cb);
        return doc;
      },
      end: () => {
        for (const cb of listeners.end ?? []) cb();
      },
      text: (value: string) => {
        written.push(value);
        return doc;
      },
      heightOfString: () => 10,
    };
    for (const method of [
      'font',
      'fontSize',
      'fillColor',
      'moveTo',
      'lineTo',
      'strokeColor',
      'lineWidth',
      'stroke',
      'addPage',
      'moveDown',
    ]) {
      doc[method] = () => doc;
    }
    return doc;
  });
});

const input: QuotationPdfInput = {
  code: 'COT-TEST-1',
  status: 'EMITTED',
  issueDate: '2026-10-09',
  validUntil: '2026-10-16',
  customerName: 'Cliente de prueba',
  customerDoc: 'RUC 00000000000',
  customerAddress: null,
  notes: null,
  items: [
    {
      description: 'Tornillo',
      qty: '10.000',
      unit: 'NIU',
      unitPricePen: '1.0000',
      valuePerMeterPen: null,
      totalPen: '10.0000',
    },
    {
      description: 'Plancha a medida',
      qty: '12.500',
      unit: 'MTR',
      unitPricePen: '20.0000',
      valuePerMeterPen: null,
      totalPen: '250.0000',
    },
  ],
  subtotalPen: '260.0000',
  igvPen: '46.8000',
  totalPen: '306.8000',
};

describe('PDF de la cotización: unidad para mostrar (D-579)', () => {
  beforeEach(() => {
    written.length = 0;
  });

  it('imprime «und» y «m», nunca el código SUNAT', async () => {
    await buildQuotationPdf(input);
    expect(written).toContain('und');
    expect(written).toContain('m');
    expect(written).not.toContain('NIU');
    expect(written).not.toContain('MTR');
  });

  it('la cantidad en unidades sigue sin ceros de relleno (formatQty, anterior a D-579)', async () => {
    await buildQuotationPdf(input);
    expect(written).toContain('10');
    expect(written).not.toContain('10.000');
  });
});
