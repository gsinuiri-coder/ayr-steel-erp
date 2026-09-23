import { InvoicingService } from './invoicing.service';

/**
 * **RF-S4b / D-253, decisión 4 del dueño: sin copia del código en el comprobante.**
 *
 * Renombrar un producto (la normalización de SKU de bobina) cambia lo que se lee **en vivo** por
 * FK —el `codigo` de un envío futuro al PSE, el PDF de orden de planta—, pero un comprobante ya
 * aceptado **no se reconstruye**: su PDF y su XML son los que el PSE devolvió al aceptarlo,
 * guardados en R2 bajo `pdfKey`/`xmlKey`. Este test fija eso: servir esos archivos lee la clave
 * guardada y devuelve sus bytes tal cual, sin consultar el producto, así que el SKU vigente del
 * producto no puede colarse en el documento legal.
 */
describe('D-253 — un comprobante aceptado sirve su XML/PDF guardado aunque el SKU cambie', () => {
  const STORED_PDF = Buffer.from('%PDF-1.4 codigo BOBALZ-AZUL-50020.38');
  const STORED_XML = Buffer.from('<cbc:ID>BOBALZ-AZUL-50020.38</cbc:ID>');

  function service() {
    const findUnique = jest.fn().mockResolvedValue({
      number: 'F001-00000123',
      pdfKey: 'fiscal/doc-1.pdf',
      xmlKey: 'fiscal/doc-1.xml',
      cdrKey: null,
      createdById: 'u-1',
      salesOrder: null,
      dispatch: null,
    });
    const productFindAny = jest.fn();
    const getObject = jest.fn((key: string) =>
      Promise.resolve(key.endsWith('.pdf') ? STORED_PDF : STORED_XML),
    );
    const svc = Object.create(InvoicingService.prototype) as InvoicingService;
    Object.assign(svc, {
      prisma: {
        fiscalDocument: { findUnique },
        product: {
          findUnique: productFindAny,
          findMany: productFindAny,
          findFirst: productFindAny,
        },
      },
      storage: { getObject },
    });
    return { svc, findUnique, productFindAny, getObject };
  }

  it.each([
    ['pdf', STORED_PDF, 'fiscal/doc-1.pdf'],
    ['xml', STORED_XML, 'fiscal/doc-1.xml'],
  ] as const)(
    '%s: devuelve los bytes guardados y no mira el producto',
    async (kind, bytes, key) => {
      const s = service();
      const file = await s.svc.file('doc-1', kind);
      expect(s.getObject).toHaveBeenCalledWith(key);
      expect(file.buffer.equals(bytes)).toBe(true);
      // Ni siquiera se pide el producto: el SKU renombrado (`BOB038AZUL`) no tiene por dónde entrar.
      expect(s.productFindAny).not.toHaveBeenCalled();
      const calls = s.findUnique.mock.calls as [{ select: Record<string, unknown> }][];
      expect(Object.keys(calls[0]?.[0].select ?? {})).not.toContain('items');
    },
  );
});
