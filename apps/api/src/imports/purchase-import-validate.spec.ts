import * as XLSX from 'xlsx';
import { parseSpreadsheet } from './parse-spreadsheet';
import { parsePurchaseRows } from './purchase-import-parse';
import type { PurchaseImportDocumentInput, PurchaseImportLineInput } from '@ayr/shared';
import {
  colorMatches,
  livePurchaseKey,
  validateDocument,
  type FinishRef,
  type PurchaseImportContext,
} from './purchase-import-validate';

/**
 * D-351/D-352 — la regla de cada comprobante del importador de compras: duplicado (D-132), doble
 * conteo contra la carga inicial, fecha (D-124, sin regla de rol), TC en dólares (D-042), color
 * contra acabado (D-203), SKU por línea, proveedor desde el padrón.
 */

const SUPPLIER = {
  id: 'sup-1',
  name: 'Aceros SAC',
  code: 'ACE',
  docNumber: '20100000001',
  isActive: true,
};
const ROOFING_FINISH = {
  id: 'fin-rojo',
  code: 'ALZ-ROJO',
  name: 'Prepintado rojo',
  kind: 'PREPINTADO',
  isActive: true,
  businessLine: 'metallic-roofing' as const,
  color: { code: 'ROJO-3020', name: 'Rojo tráfico' },
};
const GALV_DRYWALL = {
  id: 'fin-galv',
  code: 'GALV-DW',
  name: 'Galvanizado',
  kind: 'GALVANIZADO',
  isActive: true,
  businessLine: 'drywall' as const,
  color: null,
};
const PRODUCT_TRADING = {
  id: 'p-1',
  sku: 'CLAVO1',
  name: 'Clavo 1"',
  unit: 'NIU',
  businessLine: 'trading' as const,
  isActive: true,
};
const PRODUCT_DRYWALL_SAME_SKU = {
  ...PRODUCT_TRADING,
  id: 'p-2',
  businessLine: 'drywall' as const,
};

function ctx(over: Partial<PurchaseImportContext> = {}): PurchaseImportContext {
  return {
    today: '2026-09-27',
    historicalLoadStart: '2026-08-01',
    suppliersByRuc: new Map([[SUPPLIER.docNumber, SUPPLIER]]),
    suppliersById: new Map([[SUPPLIER.id, SUPPLIER]]),
    padron: new Map(),
    takenSupplierCodes: new Set(['ACE']),
    productsBySku: new Map([['CLAVO1', [PRODUCT_TRADING]]]),
    productsById: new Map([[PRODUCT_TRADING.id, PRODUCT_TRADING]]),
    finishesByCode: new Map<string, FinishRef>([
      ['ALZ-ROJO', ROOFING_FINISH],
      ['GALV-DW', GALV_DRYWALL],
    ]),
    finishesById: new Map([[ROOFING_FINISH.id, ROOFING_FINISH]]),
    livePurchases: new Map(),
    initialLoadReferences: new Map(),
    initialLoadDate: null,
    sunatRates: new Map(),
    repeatedKeys: new Set(),
    ...over,
  };
}

function line(over: Partial<PurchaseImportLineInput> = {}): PurchaseImportLineInput {
  return {
    rowNumber: 2,
    sku: '',
    productId: null,
    description: '',
    qty: '',
    unit: '',
    unitPrice: '10',
    lineAmount: '',
    finishCode: '',
    finishId: null,
    color: '',
    thicknessMm: '',
    widthMm: '',
    externalCode: '',
    ...over,
  };
}

const coilLine = (over: Partial<PurchaseImportLineInput> = {}) =>
  line({
    finishCode: 'ALZ-ROJO',
    thicknessMm: '0,30',
    widthMm: '1220',
    qty: '4500,5',
    unitPrice: '3,20',
    ...over,
  });

function doc(over: Partial<PurchaseImportDocumentInput> = {}): PurchaseImportDocumentInput {
  return {
    key: 'k-1',
    type: 'Bobinas',
    businessLine: 'Coberturas Aluzinc',
    docType: 'Factura',
    series: 'F001',
    number: '00012345',
    issueDate: '2026-09-20',
    supplierRuc: SUPPLIER.docNumber,
    supplierId: null,
    newSupplierCode: null,
    currency: 'PEN',
    exchangeRate: '',
    paymentTerms: 'Contado',
    creditDays: '',
    serviceKind: '',
    igvRate: '',
    notes: '',
    documentTotal: '',
    confirmedNotInitialLoad: false,
    lines: [coilLine()],
    ...over,
  };
}

const errors = (r: ReturnType<typeof validateDocument>) => [
  ...r.dto.issues.filter((i) => i.severity === 'error').map((i) => i.message),
  ...r.dto.lines.flatMap((l) =>
    l.issues.filter((i) => i.severity === 'error').map((i) => i.message),
  ),
];
const warnings = (r: ReturnType<typeof validateDocument>) =>
  r.dto.issues.filter((i) => i.severity === 'warning').map((i) => i.message);

describe('validateDocument — compra de bobinas válida', () => {
  it('arma el alta: tipo, línea, IGV 18 por defecto, kilos y precio con coma decimal', () => {
    const r = validateDocument(doc({ lines: [coilLine({ externalCode: 'PROV-77' })] }), ctx());
    expect(errors(r)).toEqual([]);
    expect(r.input).toMatchObject({
      supplierId: 'sup-1',
      type: 'COIL',
      businessLine: 'metallic-roofing',
      docType: 'FACTURA',
      series: 'F001',
      number: '00012345',
      igvRate: '18.0000',
      paymentTerms: 'CONTADO',
      items: [
        {
          finishId: 'fin-rojo',
          qty: '4500.500',
          unit: 'KGM',
          unitPrice: '3.2000',
          thicknessMm: '0.30',
          widthMm: '1220.00',
        },
      ],
    });
    expect(r.externalCodes).toEqual(['PROV-77']);
    // Totales con Decimal: 4500.5 × 3.20 = 14 401.60 + 18 %.
    expect(r.dto.subtotal).toBe('14401.60');
    expect(r.dto.total).toBe('16993.89');
  });
});

describe('validateDocument — duplicado y doble conteo', () => {
  it('D-132: el mismo papel ya registrado en una compra viva es error', () => {
    const r = validateDocument(
      doc(),
      ctx({
        livePurchases: new Map([
          [
            livePurchaseKey('sup-1', 'FACTURA', 'F001', '00012345'),
            { issueDate: '2026-09-20', status: 'DRAFT' },
          ],
        ]),
      }),
    );
    expect(errors(r)[0]).toMatch(/Ya registrada: compra F001-00012345 de Aceros SAC.*borrador/);
    expect(r.input).toBeNull();
  });

  it('D-352: coincide con la factura de referencia de la carga inicial → no entra sin la marca', () => {
    const c = ctx({ initialLoadReferences: new Map([['F001-12345', ['BOB-1', 'BOB-2']]]) });
    const unmarked = validateDocument(doc(), c);
    expect(errors(unmarked)[0]).toMatch(
      /Coincide con la factura de referencia de la carga inicial \(bobinas\/SKU: BOB-1, BOB-2\); la carga no guardó el proveedor\. ¿Es otra compra\?/,
    );
    expect(unmarked.input).toBeNull();
    expect(unmarked.dto.initialLoadMatch).toEqual({
      reference: 'F001-00012345',
      items: ['BOB-1', 'BOB-2'],
    });

    const marked = validateDocument(doc({ confirmedNotInitialLoad: true }), c);
    expect(errors(marked)).toEqual([]);
    expect(marked.input).not.toBeNull();
  });

  it('D-352: emitida antes de la carga inicial es un aviso, no un bloqueo', () => {
    const r = validateDocument(
      doc({ issueDate: '2026-09-01' }),
      ctx({ initialLoadDate: '2026-09-15' }),
    );
    expect(errors(r)).toEqual([]);
    expect(warnings(r)[0]).toMatch(/antes de la carga inicial del inventario \(2026-09-15\)/);
  });

  it('un comprobante repetido en el archivo con otra cabecera es error', () => {
    const r = validateDocument(doc(), ctx({ repeatedKeys: new Set(['k-1']) }));
    expect(errors(r)[0]).toMatch(/aparece dos veces/);
  });
});

describe('validateDocument — fecha (D-124, dato del papel)', () => {
  it.each([
    ['2026-09-28', /no puede ser futura/],
    ['2026-07-31', /anterior al 2026-08-01/],
    ['20/09/2026', /no es una fecha: usa DD\/MM\/AAAA/],
    ['45901', /no es una fecha/],
  ])('%s se rechaza', (issueDate, message) => {
    expect(errors(validateDocument(doc({ issueDate }), ctx()))[0]).toMatch(message);
  });
});

describe('validateDocument — moneda y tipo de cambio (D-042)', () => {
  it('USD sin TC usa el de SUNAT de la fecha de emisión y lo dice', () => {
    const r = validateDocument(
      doc({ currency: 'USD' }),
      ctx({ sunatRates: new Map([['2026-09-20', { rate: '3.7500', source: 'SUNAT' }]]) }),
    );
    expect(errors(r)).toEqual([]);
    expect(r.dto.resolvedExchangeRate).toEqual({ rate: '3.7500', source: 'SUNAT' });
    expect(warnings(r)).toContain(
      'Sin tipo de cambio en el archivo: se usará el de SUNAT del 2026-09-20 (3.7500)',
    );
    expect(r.input?.exchangeRate).toBeUndefined();
  });

  it('USD sin TC y sin SUNAT para esa fecha es error', () => {
    const r = validateDocument(
      doc({ currency: 'USD' }),
      ctx({ sunatRates: new Map([['2026-09-20', null]]) }),
    );
    expect(errors(r)[0]).toMatch(/No hay tipo de cambio SUNAT para el 2026-09-20: escríbelo/);
  });

  it('USD con TC del archivo (coma decimal) lo usa tal cual', () => {
    const r = validateDocument(doc({ currency: 'USD', exchangeRate: '3,812' }), ctx());
    expect(r.input?.exchangeRate).toBe('3.8120');
    expect(r.dto.resolvedExchangeRate).toEqual({ rate: '3.8120', source: 'MANUAL' });
  });

  it('en soles un TC se ignora con aviso', () => {
    const r = validateDocument(doc({ exchangeRate: '3.8' }), ctx());
    expect(r.input?.exchangeRate).toBeUndefined();
    expect(warnings(r)[0]).toMatch(/en soles no lleva tipo de cambio/);
  });
});

describe('validateDocument — bobina: acabado y color (D-203)', () => {
  it('un color que contradice al acabado es error de campo', () => {
    const r = validateDocument(doc({ lines: [coilLine({ color: 'Azul' })] }), ctx());
    expect(errors(r)[0]).toMatch(/Fila 2: El color «Azul» contradice al acabado ALZ-ROJO/);
  });

  it('el mismo color comercial (o su RAL exacto) pasa', () => {
    expect(errors(validateDocument(doc({ lines: [coilLine({ color: 'rojo' })] }), ctx()))).toEqual(
      [],
    );
    expect(
      errors(validateDocument(doc({ lines: [coilLine({ color: 'Rojo 3020' })] }), ctx())),
    ).toEqual([]);
  });

  it('un acabado de otra línea es error', () => {
    const r = validateDocument(doc({ lines: [coilLine({ finishCode: 'GALV-DW' })] }), ctx());
    expect(errors(r)[0]).toMatch(/El acabado GALV-DW es de otra línea/);
  });

  it('acabado inexistente, espesor o ancho faltantes', () => {
    const r = validateDocument(
      doc({ lines: [coilLine({ finishCode: 'NADA', thicknessMm: '', widthMm: '' })] }),
      ctx(),
    );
    expect(errors(r)).toEqual([
      expect.stringMatching(/El acabado NADA no existe/),
      expect.stringMatching(/espesor en mm es obligatorio/),
      expect.stringMatching(/ancho en mm es obligatorio/),
    ]);
  });

  it('una bobina no lleva SKU ni otra unidad que el kilo', () => {
    const r = validateDocument(doc({ lines: [coilLine({ sku: 'X', unit: 'NIU' })] }), ctx());
    expect(errors(r)).toEqual([
      expect.stringMatching(/se compran por kilo/),
      expect.stringMatching(/no lleva SKU/),
    ]);
  });

  it('solo Drywall y Coberturas Aluzinc compran bobinas', () => {
    const r = validateDocument(doc({ businessLine: 'Reventa' }), ctx());
    expect(errors(r)[0]).toMatch(/Solo Drywall y Coberturas Aluzinc compran bobinas/);
  });
});

describe('validateDocument — producto terminado: el SKU por la línea de la cabecera', () => {
  const fg = (over: Partial<PurchaseImportDocumentInput> = {}) =>
    doc({
      type: 'Producto terminado',
      businessLine: 'Reventa',
      lines: [line({ sku: 'clavo1', qty: '100' })],
      ...over,
    });

  it('resuelve el SKU, la unidad del producto y su nombre como descripción', () => {
    const r = validateDocument(fg(), ctx());
    expect(errors(r)).toEqual([]);
    expect(r.input?.items[0]).toMatchObject({
      productId: 'p-1',
      unit: 'NIU',
      description: 'Clavo 1"',
    });
  });

  it('un SKU que solo es de otra línea es error de campo', () => {
    const r = validateDocument(fg({ businessLine: 'Drywall' }), ctx());
    expect(errors(r)[0]).toMatch(/El SKU clavo1 es de otra línea \(trading\)/);
  });

  it('con el mismo SKU en dos líneas se toma el de la línea de la compra', () => {
    const c = ctx({
      productsBySku: new Map([['CLAVO1', [PRODUCT_TRADING, PRODUCT_DRYWALL_SAME_SKU]]]),
    });
    expect(validateDocument(fg({ businessLine: 'Drywall' }), c).input?.items[0]?.productId).toBe(
      'p-2',
    );
  });

  it('un SKU desconocido pide crearlo', () => {
    const r = validateDocument(fg({ lines: [line({ sku: 'NUEVO', qty: '1' })] }), ctx());
    expect(errors(r)[0]).toMatch(/El SKU NUEVO no está en el catálogo: créalo o elige otro/);
  });

  it('el producto elegido en pantalla gana sobre el SKU', () => {
    const r = validateDocument(
      fg({ lines: [line({ sku: 'NUEVO', productId: 'p-1', qty: '1' })] }),
      ctx(),
    );
    expect(r.input?.items[0]?.productId).toBe('p-1');
  });
});

describe('validateDocument — proveedor desde el padrón (D-158, código editable)', () => {
  const unknownRuc = '20999999999';

  it('RUC que el maestro no tiene y el padrón sí: se crea con el código elegido', () => {
    const r = validateDocument(
      doc({ supplierRuc: unknownRuc, newSupplierCode: 'NUE' }),
      ctx({ padron: new Map([[unknownRuc, 'NUEVO PROVEEDOR SAC']]) }),
    );
    expect(errors(r)).toEqual([]);
    expect(r.dto.newSupplier).toEqual({ name: 'NUEVO PROVEEDOR SAC', suggestedCode: 'NUE' });
    expect(r.input?.supplierId).toBe('');
  });

  it('un código inválido o ya tomado es error del campo', () => {
    const c = ctx({ padron: new Map([[unknownRuc, 'NUEVO SAC']]) });
    expect(
      errors(validateDocument(doc({ supplierRuc: unknownRuc, newSupplierCode: 'N1' }), c))[0],
    ).toMatch(/entre 3 y 6 letras/);
    expect(
      errors(validateDocument(doc({ supplierRuc: unknownRuc, newSupplierCode: 'ACE' }), c))[0],
    ).toMatch(/El código ACE ya es de otro proveedor/);
  });

  it('ni en el maestro ni en el padrón: pide el alta', () => {
    const r = validateDocument(doc({ supplierRuc: unknownRuc }), ctx());
    expect(errors(r)[0]).toMatch(/no está en el maestro ni lo devolvió el padrón/);
  });

  it('un proveedor desactivado es error', () => {
    const inactive = { ...SUPPLIER, isActive: false };
    const r = validateDocument(
      doc(),
      ctx({ suppliersByRuc: new Map([[SUPPLIER.docNumber, inactive]]) }),
    );
    expect(errors(r)[0]).toMatch(/está desactivado/);
  });
});

describe('validateDocument — cabecera', () => {
  it('una nota de crédito no se importa', () => {
    expect(errors(validateDocument(doc({ docType: 'Nota de crédito' }), ctx()))[0]).toMatch(
      /solo factura o boleta/,
    );
  });

  it('crédito sin días es error; con días entra', () => {
    expect(errors(validateDocument(doc({ paymentTerms: 'Crédito' }), ctx()))[0]).toMatch(
      /días de crédito/,
    );
    expect(
      validateDocument(doc({ paymentTerms: 'Crédito', creditDays: '30' }), ctx()).input?.creditDays,
    ).toBe(30);
  });

  it('un servicio necesita su tipo y avisa que entra sin vincular', () => {
    const service = (serviceKind: string) =>
      doc({
        type: 'Servicio',
        serviceKind,
        lines: [line({ description: 'Flete Lima', qty: '1' })],
      });
    expect(errors(validateDocument(service(''), ctx()))[0]).toMatch(/tipo de servicio/);
    const ok = validateDocument(service('Flete'), ctx());
    expect(ok.input).toMatchObject({
      type: 'SERVICE',
      serviceKind: 'FREIGHT',
      items: [{ unit: 'NIU' }],
    });
    expect(warnings(ok)[0]).toMatch(/sin vincular/);
  });

  it('un gasto sin descripción es error', () => {
    const r = validateDocument(
      doc({ type: 'Gasto', businessLine: 'Servicios', lines: [line({ qty: '1' })] }),
      ctx(),
    );
    expect(errors(r)[0]).toMatch(/necesita su descripción/);
  });

  it('D-359: el total del archivo que no cuadra es un error con las dos cifras con IGV', () => {
    const r = validateDocument(doc({ documentTotal: '17000' }), ctx());
    expect(r.input).toBeNull();
    expect(errors(r).join(' ')).toMatch(
      /con IGV \(17000\.00\) no cuadra con el recalculado con IGV \(16993\.89\): diferencia 6\.11/,
    );
  });

  it('dentro de la tolerancia de redondeo no avisa', () => {
    expect(warnings(validateDocument(doc({ documentTotal: '16993,95' }), ctx()))).toEqual([]);
  });

  it('valores que no son de ningún catálogo se nombran', () => {
    const r = validateDocument(
      doc({
        type: 'Compra',
        businessLine: 'Acero',
        currency: 'EUR',
        paymentTerms: 'Plazos',
        igvRate: 'x',
      }),
      ctx(),
    );
    expect(errors(r)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/no es un tipo de compra/),
        expect.stringMatching(/no es una línea de negocio/),
        expect.stringMatching(/no es una moneda/),
        expect.stringMatching(/no es una condición de pago/),
        expect.stringMatching(/no es una tasa de IGV/),
      ]),
    );
  });
});

describe('colorMatches', () => {
  const rojo = { code: 'ROJO-3020', name: 'Rojo tráfico' };
  it.each([
    ['Rojo', true],
    ['ROJO-3020', true],
    ['3020', true],
    ['Rojo 3002', false],
    ['Azul 3020', false],
    ['Azul', false],
  ])('%s → %s', (written, expected) => {
    expect(colorMatches(written, rojo)).toBe(expected);
  });
});

describe('validateDocument — el alta pasa por createPurchaseSchema (autorrevisión, P1)', () => {
  it('kilos que el redondeo deja en cero son error de la fila, no una bobina de 0 kg', () => {
    const r = validateDocument(doc({ lines: [coilLine({ qty: '0,0004' })] }), ctx());
    expect(r.input).toBeNull();
    expect(r.dto.lines[0]?.issues[0]).toMatchObject({
      field: 'lines.0.qty',
      message: expect.stringMatching(/^Fila 2: /),
    });
  });

  it('un precio fuera de rango no llega a la base (sin 500 por overflow)', () => {
    const r = validateDocument(
      doc({ lines: [coilLine({ unitPrice: '99999999999999999999' })] }),
      ctx(),
    );
    expect(r.input).toBeNull();
    expect(r.dto.lines[0]?.issues.length).toBeGreaterThan(0);
  });

  it('el duplicado vivo se detecta aunque el número traiga otros ceros a la izquierda', () => {
    const r = validateDocument(
      doc({ number: '12345' }),
      ctx({
        livePurchases: new Map([
          [
            livePurchaseKey('sup-1', 'FACTURA', 'F001', '00012345'),
            { issueDate: '2026-09-20', status: 'RECEIVED' },
          ],
        ]),
      }),
    );
    expect(errors(r)[0]).toMatch(/Ya registrada/);
  });
});

/**
 * D-359 — el total del papel manda. El caso real del dueño: `F001-00043612`, 500 unidades a
 * 0.144068 sin IGV, importe 72.03, IGV 12.97, total 85.00. Antes daba «El total del archivo
 * (85.00) no cuadra con el recalculado (72.18)»: la tasa llegaba como 0.18 (celda de porcentaje)
 * y el precio se redondeaba a cuatro decimales antes de multiplicar.
 */
describe('validateDocument — D-359 el total del papel manda', () => {
  const goods = (lineOver: Partial<PurchaseImportLineInput>, docOver = {}) =>
    doc({
      type: 'Producto terminado',
      businessLine: 'Reventa',
      lines: [line({ sku: 'CLAVO1', qty: '500', unit: 'NIU', unitPrice: '', ...lineOver })],
      ...docOver,
    });

  it('el archivo del dueño (tasa como 0.18, total 85.00) pasa sin aviso y queda en 85.00 exacto', () => {
    const r = validateDocument(
      goods({ unitPrice: '0.144068' }, { igvRate: '0.18', documentTotal: '85' }),
      ctx(),
    );
    expect(errors(r)).toEqual([]);
    expect(warnings(r)).toEqual([]);
    expect(r.input?.igvRate).toBe('18.0000');
    // 500 × 0.144068 = 72.034 con todos los decimales; el IGV absorbe el redondeo.
    expect(r.amounts).toEqual([{ subtotal: '72.0340', igv: '12.9660' }]);
    expect(r.dto.total).toBe('85.00');
    // El unitario guardado es de cuatro decimales, solo para mostrar.
    expect(r.input?.items[0]?.unitPrice).toBe('0.1441');
  });

  it('con importe de línea, el importe manda y el unitario se deriva', () => {
    const r = validateDocument(
      goods(
        { unitPrice: '0.144068', lineAmount: '72.03' },
        { igvRate: '18%', documentTotal: '85.00' },
      ),
      ctx(),
    );
    expect(errors(r)).toEqual([]);
    expect(r.amounts).toEqual([{ subtotal: '72.0300', igv: '12.9700' }]);
    expect(r.input?.items[0]?.unitPrice).toBe('0.1441');
  });

  it('importe de línea sin precio unitario también alcanza', () => {
    const r = validateDocument(
      goods({ lineAmount: '1.234,56' }, { documentTotal: '1456,78' }),
      ctx(),
    );
    expect(errors(r)).toEqual([]);
    expect(r.amounts[0]?.subtotal).toBe('1234.5600');
    expect(r.dto.total).toBe('1456.78');
  });

  it('un precio con más de cuatro decimales se usa entero', () => {
    const r = validateDocument(goods({ qty: '2500', unitPrice: '3.050847' }), ctx());
    // 2500 × 3.050847 = 7627.1175; redondeado a cuatro decimales el precio habría dado 7627.25.
    expect(r.amounts[0]?.subtotal).toBe('7627.1175');
  });

  it('una diferencia de céntimos se absorbe en el IGV de la última línea', () => {
    const r = validateDocument(goods({ lineAmount: '100' }, { documentTotal: '118.03' }), ctx());
    expect(errors(r)).toEqual([]);
    expect(r.amounts).toEqual([{ subtotal: '100.0000', igv: '18.0300' }]);
  });

  it('una diferencia grande es error del total con las dos cifras con IGV', () => {
    const r = validateDocument(goods({ lineAmount: '100' }, { documentTotal: '120' }), ctx());
    expect(r.input).toBeNull();
    expect(errors(r).join(' ')).toMatch(
      /El total del archivo con IGV \(120\.00\) no cuadra con el recalculado con IGV \(118\.00\): diferencia 2\.00/,
    );
  });

  it('exonerado (tasa 0): el redondeo va al valor, no hay IGV que inventar', () => {
    const r = validateDocument(
      goods({ lineAmount: '5.5' }, { igvRate: '0', documentTotal: '5.52' }),
      ctx(),
    );
    expect(errors(r)).toEqual([]);
    expect(r.amounts).toEqual([{ subtotal: '5.5200', igv: '0.0000' }]);
  });

  it('un importe que no se parece a cantidad × precio es error de la línea', () => {
    const r = validateDocument(goods({ unitPrice: '0.17', lineAmount: '72.03' }), ctx());
    expect(errors(r).join(' ')).toMatch(
      /importe sin IGV \(72\.03\) no cuadra con cantidad × precio \(85\.00\)/,
    );
  });

  it('una compra en dólares compara en dólares y conserva su TC', () => {
    const r = validateDocument(
      goods(
        { lineAmount: '1000' },
        { currency: 'USD', exchangeRate: '3,745', documentTotal: '1180' },
      ),
      ctx(),
    );
    expect(errors(r)).toEqual([]);
    expect(r.input?.exchangeRate).toBe('3.7450');
    expect(r.amounts).toEqual([{ subtotal: '1000.0000', igv: '180.0000' }]);
  });
});

/**
 * D-359 — el camino exacto del archivo del dueño: un xlsx cuya columna TASA IGV tiene formato de
 * porcentaje (la celda guarda 0.18), con números en celdas numéricas. Pasa por el mismo lector que
 * el preview (`parseSpreadsheet` + `parsePurchaseRows`) y por la misma validación.
 */
describe('D-359 — xlsx con la tasa en formato de porcentaje', () => {
  function xlsxOf(rows: Record<string, string | number>[], percentColumn: string): Buffer {
    const sheet = XLSX.utils.json_to_sheet(rows);
    const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
    const header = Object.keys(rows[0] ?? {});
    const col = header.indexOf(percentColumn);
    for (let r = 1; r <= range.e.r; r += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c: col })] as XLSX.CellObject | undefined;
      if (cell) cell.z = '0%';
    }
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Compras');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  it('F001-00043612: 500 × 0.144068, tasa 18 % y total 85 → sin aviso, total 85.00', () => {
    const buffer = xlsxOf(
      [
        {
          'TIPO DE COMPRA': 'Producto terminado',
          'LÍNEA DE NEGOCIO': 'Reventa',
          'TIPO DE COMPROBANTE': 'Factura',
          'SERIE-NÚMERO': 'F001-00043612',
          'FECHA DE EMISIÓN': '12/08/2026',
          'RUC PROVEEDOR': SUPPLIER.docNumber,
          MONEDA: 'PEN',
          'CONDICIÓN DE PAGO': 'Contado',
          'TASA IGV': 0.18,
          'TOTAL COMPROBANTE': 85,
          SKU: 'CLAVO1',
          CANTIDAD: 500,
          UNIDAD: 'NIU',
          'PRECIO UNITARIO SIN IGV': 0.144068,
        },
      ],
      'TASA IGV',
    );
    const parsed = parsePurchaseRows(parseSpreadsheet(buffer));
    const [document] = parsed.documents;
    expect(document?.igvRate).toBe('0.18');
    const r = validateDocument(document!, ctx());
    expect(errors(r)).toEqual([]);
    expect(warnings(r)).toEqual([]);
    expect(r.dto.total).toBe('85.00');
    expect(r.amounts).toEqual([{ subtotal: '72.0340', igv: '12.9660' }]);
  });
});
