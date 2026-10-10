import * as XLSX from 'xlsx';
import type { InventoryValuationDto, SalesMarginDto } from '@ayr/shared';
import { inventoryValuationXlsx, salesMarginXlsx } from './reports-xlsx';

/**
 * RF-S4a/M3.
 *
 * Lo que puede salir mal en un export no es el contenido —sale del mismo DTO que la
 * pantalla— sino el **tipo de celda**: un total que llega como texto se ve igual al abrir el
 * archivo y no se puede sumar, que es lo primero que alguien hace con él. Por eso los casos
 * miran `cell.t` (`'n'` número, `'s'` texto) y no solo el valor.
 */

function sheetOf(buffer: Buffer, name: string): XLSX.WorkSheet {
  const book = XLSX.read(buffer, { type: 'buffer' });
  const sheet = book.Sheets[name];
  if (!sheet) throw new Error(`El libro no tiene la hoja ${name}: ${book.SheetNames.join(', ')}`);
  return sheet;
}

function cell(sheet: XLSX.WorkSheet, ref: string): XLSX.CellObject | undefined {
  return sheet[ref] as XLSX.CellObject | undefined;
}

const valuation: InventoryValuationDto = {
  asOf: '2026-09-22',
  coilGroups: [
    {
      key: 'drywall|0.50|',
      businessLine: 'drywall',
      thicknessMm: '0.50',
      colorName: null,
      finishKind: 'GALVANIZADO',
      finishes: [
        {
          finishCode: 'GALV',
          finishName: 'GALVANIZADO',
          ral: null,
          coilCount: 1,
          qtyKg: '800.000',
          totalValuePen: '4000.0000',
        },
      ],
      coilCount: 1,
      qtyKg: '800.000',
      avgCostPen: '5.0000',
      totalValuePen: '4000.0000',
      coils: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          code: 'BOB-001',
          typeKey: 'GALV-0.50',
          finishName: 'Galvanizado',
          kind: 'COIL',
          widthMm: '1200.00',
          finishCode: 'GALV',
          ral: null,
          qtyKg: '800.000',
          avgCostPen: '5.0000',
          totalValuePen: '4000.0000',
          status: 'OPEN',
          operationDate: '2026-09-01',
        },
      ],
    },
  ],
  products: [
    {
      itemId: '22222222-2222-2222-2222-222222222222',
      businessLine: 'drywall',
      sku: 'SKU-1',
      name: 'Plancha',
      qty: '13.000',
      unit: 'NIU',
      avgCostPen: '18.7766',
      totalValuePen: '244.0958',
    },
  ],
  totalsByLine: [
    {
      businessLine: 'drywall',
      coilValuePen: '4000.0000',
      productValuePen: '244.0958',
      totalValuePen: '4244.0958',
    },
  ],
  totals: {
    coilValuePen: '4000.0000',
    coilQtyKg: '1000.000',
    productValuePen: '244.0958',
    totalValuePen: '4244.0958',
  },
};

const margin: SalesMarginDto = {
  from: '2026-09-01',
  to: '2026-09-30',
  orders: [
    {
      salesOrderId: '33333333-3333-3333-3333-333333333333',
      orderCode: 'PED-000012',
      customerId: '00000000-0000-4000-a000-0000000000c1',
      customerName: 'Cliente S.A.',
      sellerId: '00000000-0000-4000-a000-0000000000d1',
      sellerName: 'Vendedor Uno',
      salesPen: '1000.0000',
      costPen: '600.0000',
      opMaterialCostPen: '0.0000',
      marginPen: '400.0000',
      marginPct: '40.00',
      costStatus: 'COMPLETO',
      inTotals: true,
      documents: [
        {
          id: '44444444-4444-4444-4444-444444444444',
          number: 'F001-00000012',
          docType: 'FACTURA',
          status: 'ACCEPTED',
          origin: 'ISSUED_HERE',
          issueDate: '2026-09-10',
          salesPen: '1000.0000',
          costPen: null,
          marginPen: null,
          marginPct: null,
        },
      ],
    },
    {
      salesOrderId: '55555555-5555-5555-5555-555555555555',
      orderCode: 'PED-000013',
      customerId: '00000000-0000-4000-a000-0000000000c2',
      customerName: 'Otro Cliente',
      sellerId: null,
      sellerName: null,
      salesPen: '400.0000',
      costPen: null,
      opMaterialCostPen: '0.0000',
      marginPen: null,
      marginPct: null,
      costStatus: 'NO_COMPARABLE',
      inTotals: false,
      documents: [],
    },
  ],
  totalsByLine: [
    {
      businessLine: 'drywall',
      salesPen: '1000.0000',
      costPen: '600.0000',
      marginPen: '400.0000',
      marginPct: '40.00',
    },
  ],
  totals: {
    salesPen: '1000.0000',
    noCostSalesPen: '0.0000',
    costPen: '600.0000',
    marginPen: '400.0000',
    marginPct: '40.00',
    partialOrderCount: 0,
    excludedOrderCount: 1,
    excludedSalesPen: '400.0000',
    untraceableOrderCount: 0,
    untraceableSalesPen: '0.0000',
    roundingPen: '0.0000',
  },
};

describe('reports-xlsx', () => {
  describe('inventario valorizado', () => {
    it('trae las cuatro hojas y nombra el archivo por la fecha de corte', () => {
      const { buffer, filename } = inventoryValuationXlsx(valuation);
      const book = XLSX.read(buffer, { type: 'buffer' });

      expect(book.SheetNames).toEqual(['Bobinas por grupo', 'Bobinas', 'Productos', 'Totales']);
      expect(filename).toBe('inventario-valorizado-2026-09-22.xlsx');
    });

    it('los montos son celdas numéricas, sumables, y no texto', () => {
      const { buffer } = inventoryValuationXlsx(valuation);
      const sheet = sheetOf(buffer, 'Bobinas por grupo');

      // Fila 2 = primer grupo (la 1 es el encabezado). G = Valor.
      expect(cell(sheet, 'G2')?.t).toBe('n');
      expect(cell(sheet, 'G2')?.v).toBe(4000);
      // Y el encabezado sí es texto, para que el contraste quede probado y no asumido.
      expect(cell(sheet, 'G1')?.t).toBe('s');
      expect(cell(sheet, 'G1')?.v).toBe('Valor (S/)');
    });

    it('no pierde decimales al pasar de la escala dinero a la celda', () => {
      const { buffer } = inventoryValuationXlsx(valuation);
      const sheet = sheetOf(buffer, 'Productos');

      expect(cell(sheet, 'G2')?.v).toBe(244.0958);
    });

    it('la última fila de totales es el total general', () => {
      const { buffer } = inventoryValuationXlsx(valuation);
      const sheet = sheetOf(buffer, 'Totales');

      // Fila 2 = la línea; fila 3 = el total general.
      expect(cell(sheet, 'A3')?.v).toBe('Total general');
      expect(cell(sheet, 'D3')?.v).toBe(4244.0958);
    });

    it('las etiquetas van en español, no el código del enum', () => {
      const { buffer } = inventoryValuationXlsx(valuation);
      const sheet = sheetOf(buffer, 'Bobinas');

      expect(cell(sheet, 'L2')?.v).not.toBe('OPEN');
      // D-272: sin color, el grupo es el tipo del acabado, y el acabado y su RAL van al lado.
      expect(cell(sheet, 'D2')?.v).toBe('Galvanizado');
      expect(cell(sheet, 'E1')?.v).toBe('Acabado');
      expect(cell(sheet, 'E2')?.v).toBe('GALV');
      expect(cell(sheet, 'F1')?.v).toBe('RAL');
      expect(cell(sheet, 'F2')?.v).toBe('');
      expect(cell(sheetOf(buffer, 'Bobinas por grupo'), 'C2')?.v).toBe('Galvanizado');
    });
  });

  describe('ventas y margen', () => {
    it('separa lo que suma de lo que no, en hojas distintas', () => {
      const { buffer, filename } = salesMarginXlsx(margin);
      const book = XLSX.read(buffer, { type: 'buffer' });

      expect(book.SheetNames).toEqual(['Por pedido', 'Facturación parcial', 'Totales']);
      expect(filename).toBe('ventas-margen-2026-09-01-a-2026-09-30.xlsx');

      // El pedido no comparable no está en la hoja que suma: quien totalice esa columna
      // tiene que obtener el total del reporte, y eso exige que lo excluido no esté ahí.
      const included = sheetOf(buffer, 'Por pedido');
      expect(cell(included, 'A2')?.v).toBe('PED-000012');
      expect(cell(included, 'A4')).toBeUndefined();

      const excluded = sheetOf(buffer, 'Facturación parcial');
      expect(cell(excluded, 'A2')?.v).toBe('PED-000013');
    });

    it('un costo que no se puede trazar deja la celda vacía, no en cero', () => {
      const { buffer } = salesMarginXlsx(margin);
      const sheet = sheetOf(buffer, 'Por pedido');

      // Fila 3 = el comprobante del primer pedido; G = Costo, que va null porque su despacho
      // no está declarado. Vacío y cero significan cosas distintas y el archivo lo respeta.
      expect(cell(sheet, 'G3')).toBeUndefined();
      // El del pedido sí está.
      expect(cell(sheet, 'G2')?.t).toBe('n');
      expect(cell(sheet, 'G2')?.v).toBe(600);
    });

    it('los totales llevan el conteo de filas parciales y excluidas', () => {
      const { buffer } = salesMarginXlsx(margin);
      const sheet = sheetOf(buffer, 'Totales');

      expect(cell(sheet, 'A3')?.v).toBe(
        'Total del rango (margen sin Servicios ni líneas sin producto)',
      );
      expect(cell(sheet, 'A4')?.v).toBe(
        'Sin costo registrado (Servicios y líneas sin producto), fuera del margen',
      );
      expect(cell(sheet, 'A6')?.v).toBe('Pedidos con costo parcial');
      expect(cell(sheet, 'B7')?.v).toBe(1);
      expect(cell(sheet, 'B8')?.v).toBe(400);
    });

    it('D-409: Servicios va sin costo ni margen y su venta aparte del margen del total', () => {
      const { buffer } = salesMarginXlsx({
        ...margin,
        totalsByLine: [
          ...margin.totalsByLine,
          {
            businessLine: 'services',
            salesPen: '100.0000',
            costPen: '0.0000',
            marginPen: '100.0000',
            marginPct: '100.00',
          },
        ],
        totals: {
          ...margin.totals,
          salesPen: '1100.0000',
          noCostSalesPen: '100.0000',
        },
      });
      const sheet = sheetOf(buffer, 'Totales');

      expect(cell(sheet, 'A3')?.v).toBe('Servicios');
      expect(cell(sheet, 'B3')?.v).toBe(100);
      expect(cell(sheet, 'C3')).toBeUndefined();
      expect(cell(sheet, 'D3')).toBeUndefined();
      expect(cell(sheet, 'A5')?.v).toBe(
        'Sin costo registrado (Servicios y líneas sin producto), fuera del margen',
      );
      expect(cell(sheet, 'B5')?.v).toBe(100);
    });
  });
});

describe('cc39 (D-580): el Excel de la pestaña de una línea', () => {
  const headerOf = (buffer: Buffer, name: string): unknown[] =>
    XLSX.utils.sheet_to_json<unknown[]>(sheetOf(buffer, name), { header: 1 })[0] ?? [];
  const rowsOf = (buffer: Buffer, name: string): unknown[][] =>
    XLSX.utils.sheet_to_json<unknown[]>(sheetOf(buffer, name), { header: 1 });

  it('ventas y margen de Drywall: sin «Material de OPs» y con el total de la pestaña', () => {
    const { buffer, filename } = salesMarginXlsx(margin, 'drywall');
    expect(filename).toBe('ventas-margen-2026-09-01-a-2026-09-30-drywall.xlsx');
    const header = headerOf(buffer, 'Por pedido');
    expect(header).not.toContain('Material de OPs (S/)');
    expect(header).toContain('Costo (S/)');
    const total = rowsOf(buffer, 'Totales').find((r) => r[0] === 'Total Drywall');
    expect(total).toEqual(['Total Drywall', 1000, 600, 400, 40]);
  });

  it('ventas y margen de Servicios: sin costo ni margen, solo la venta (D-392)', () => {
    const { buffer } = salesMarginXlsx(margin, 'services');
    const header = headerOf(buffer, 'Por pedido');
    for (const name of ['Costo (S/)', 'Margen (S/)', 'Margen %', 'Material de OPs (S/)']) {
      expect(header).not.toContain(name);
    }
    // Las filas tienen tantas celdas como la cabecera: nada corrido de columna.
    const first = rowsOf(buffer, 'Por pedido')[1] ?? [];
    expect(first[header.indexOf('Venta sin IGV (S/)')]).toBe(1000);
    expect(first[header.indexOf('Costo / Emisión')]).toBe('Completo');
    const total = rowsOf(buffer, 'Totales')[1] ?? [];
    expect(total[0]).toBe('Total Servicios (sin costo registrado)');
    expect(total[1]).toBe(1000);
    expect(total.slice(2).every((c) => c === undefined || c === null)).toBe(true);
  });

  it('«Todas» no cambia: las once columnas y el archivo de siempre', () => {
    const { buffer, filename } = salesMarginXlsx(margin);
    expect(filename).toBe('ventas-margen-2026-09-01-a-2026-09-30.xlsx');
    expect(headerOf(buffer, 'Por pedido')).toHaveLength(11);
  });

  it('inventario valorizado de una línea: el archivo la nombra; kg a dos decimales a la vista', () => {
    const { buffer, filename } = inventoryValuationXlsx(valuation, 'drywall');
    expect(filename).toBe('inventario-valorizado-2026-09-22-drywall.xlsx');
    // El valor completo en la celda (la suma da el total); el formato solo decide lo que se ve.
    const book = XLSX.read(buffer, { type: 'buffer', cellNF: true });
    const kg = book.Sheets['Bobinas por grupo']?.E2 as XLSX.CellObject | undefined;
    expect(kg?.t).toBe('n');
    expect(kg?.z).toBe('#,##0.00');
  });
});
