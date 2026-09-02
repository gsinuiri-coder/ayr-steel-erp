import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { parseInvoiceXml } from './invoice-xml';

const fixture = (name: string): Buffer => readFileSync(join(__dirname, '__fixtures__', name));

describe('parseInvoiceXml (RF-11, UBL 2.1)', () => {
  describe('factura en soles al contado', () => {
    const parsed = parseInvoiceXml(fixture('factura-pen-contado.xml'));

    it('lee emisor, comprobante, fecha y moneda', () => {
      expect(parsed).toMatchObject({
        supplierDocNumber: '20601234567',
        supplierName: 'ACEROS DEL NORTE S.A.C.',
        docType: 'FACTURA',
        series: 'F001',
        number: '1523',
        issueDate: '2026-08-20',
        currency: 'PEN',
      });
    });

    it('reconoce el contado y no inventa fecha de vencimiento', () => {
      expect(parsed.paymentTerms).toBe('CONTADO');
      expect(parsed.dueDate).toBeNull();
      expect(parsed.creditDays).toBeNull();
    });

    it('lee los totales del documento y la tasa de IGV declarada', () => {
      expect(parsed.subtotal).toBe('24200.0000');
      expect(parsed.igv).toBe('4356.0000');
      expect(parsed.total).toBe('28556.0000');
      expect(parsed.igvRate).toBe('18.0000');
      expect(parsed.warnings).toEqual([]);
    });

    it('lee las dos líneas con su cantidad, unidad y precio SIN IGV (D-038)', () => {
      expect(parsed.lines).toHaveLength(2);
      expect(parsed.lines[0]).toEqual({
        lineNumber: 1,
        description: 'BOBINA LAMINADO EN CALIENTE (LAC) 2.00MM x 1220MM',
        sellerItemCode: 'BOB-LAC-200',
        qty: '5000.000',
        unit: 'KGM',
        // El precio sin IGV es cac:Price, no el AlternativeConditionPrice (5.0032, con IGV).
        unitPrice: '4.2400',
        subtotal: '21200.0000',
        igv: '3816.0000',
      });
      expect(parsed.lines[1]).toMatchObject({
        lineNumber: 2,
        sellerItemCode: 'BOB-GAL-150',
        qty: '1500.000',
        unitPrice: '2.0000',
        subtotal: '3000.0000',
      });
    });

    it('ignora el bloque de firma digital sin romperse', () => {
      // La firma vive en ext:UBLExtensions; leerla no es necesario para prellenar la compra.
      expect(parsed.lines.every((l) => l.description.length > 0)).toBe(true);
    });
  });

  describe('factura en dólares al crédito con cuotas', () => {
    const parsed = parseInvoiceXml(fixture('factura-usd-credito.xml'));

    it('lee emisor, comprobante con ceros a la izquierda y moneda extranjera', () => {
      expect(parsed).toMatchObject({
        supplierDocNumber: '20609876543',
        supplierName: 'SIDERURGIA ANDINA S.A.C.',
        series: 'F002',
        // El correlativo se normaliza sin ceros a la izquierda.
        number: '87',
        currency: 'USD',
        issueDate: '2026-08-25',
      });
    });

    it('reconoce el crédito y toma la fecha de la primera cuota', () => {
      expect(parsed.paymentTerms).toBe('CREDITO');
      expect(parsed.dueDate).toBe('2026-09-24');
      expect(parsed.creditDays).toBe(30);
    });

    it('lee los totales en la moneda del documento', () => {
      expect(parsed.subtotal).toBe('14008.4746');
      expect(parsed.igv).toBe('2521.5254');
      expect(parsed.total).toBe('16530.0000');
    });

    it('avisa cuando los precios unitarios no reproducen el valor de venta del comprobante', () => {
      // La línea 2 redondea el precio a 1.2632: 3300 × 1.2632 = 4168.56 contra los
      // 4168.4746 que declara el XML. El ERP recalcula desde el precio, así que el
      // usuario tiene que ver la diferencia antes de confirmar la cuenta por pagar.
      expect(parsed.warnings.some((w) => w.includes('recalculado desde los precios'))).toBe(true);
    });

    it('tolera una línea sin código de producto del proveedor', () => {
      expect(parsed.lines[0]?.sellerItemCode).toBe('GAL-050-1220');
      expect(parsed.lines[1]?.sellerItemCode).toBeNull();
      expect(parsed.lines[1]).toMatchObject({ qty: '3300.000', unitPrice: '1.2632' });
    });
  });

  describe('entradas inválidas o peligrosas', () => {
    it('rechaza un XML con DOCTYPE (XXE / billion laughs)', () => {
      const evil = Buffer.from(
        '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Invoice/>',
        'utf8',
      );
      expect(() => parseInvoiceXml(evil)).toThrow(BadRequestException);
    });

    it('rechaza un ZIP con un mensaje que dice qué hacer', () => {
      const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
      expect(() => parseInvoiceXml(zip)).toThrow(/ZIP/);
    });

    it('rechaza un XML que no es un comprobante UBL', () => {
      const other = Buffer.from('<?xml version="1.0"?><root><a>1</a></root>', 'utf8');
      expect(() => parseInvoiceXml(other)).toThrow(/UBL 2.1/);
    });

    it('rechaza un archivo vacío', () => {
      expect(() => parseInvoiceXml(Buffer.alloc(0))).toThrow(BadRequestException);
    });

    it('rechaza una moneda no soportada', () => {
      const eur = readFileSync(
        join(__dirname, '__fixtures__', 'factura-pen-contado.xml'),
        'utf8',
      ).replace('>PEN</cbc:DocumentCurrencyCode>', '>EUR</cbc:DocumentCurrencyCode>');
      expect(() => parseInvoiceXml(Buffer.from(eur, 'utf8'))).toThrow(/Moneda EUR/);
    });
  });
});
