import { readFileSync } from 'node:fs';
import { BadRequestException } from '@nestjs/common';
import { InventoryItemType, type Prisma } from '@prisma/client';
import { parseSpreadsheet } from './parse-spreadsheet';
import { documentKeyOf, issueDateOf, parsePurchaseRows } from './purchase-import-parse';
import { initialLoadReferencesOf, referenceOf } from './purchase-import-initial-load';

/** D-351 — lectura de la planilla de compras y D-352 — las referencias de la carga inicial. */

const HEADER =
  'TIPO DE COMPRA,LÍNEA DE NEGOCIO,TIPO DE COMPROBANTE,SERIE-NÚMERO,FECHA DE EMISIÓN,RUC PROVEEDOR,MONEDA,TIPO DE CAMBIO,CONDICIÓN DE PAGO,DÍAS DE CRÉDITO,TIPO DE SERVICIO,TASA IGV,OBSERVACIONES,TOTAL COMPROBANTE,SKU,DESCRIPCIÓN,CANTIDAD,UNIDAD,PRECIO UNITARIO SIN IGV,CÓDIGO DE ACABADO,COLOR,ESPESOR MM,ANCHO MM,KG,CÓDIGO EXTERNO';

function csv(...rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join('\n'), 'utf8');
}

describe('parsePurchaseRows (D-351)', () => {
  it('agrupa las filas por RUC + tipo + serie-número y lee la fecha DD/MM/AAAA como texto', () => {
    const parsed = parsePurchaseRows(
      parseSpreadsheet(
        csv(
          'Bobinas,Coberturas Aluzinc,Factura,F001-00012345,03/08/2026,20100000001,USD,"3,75",Contado,,,18,Primera,,,,,,"3,20",ALZ-ROJO,Rojo,"0,30",1220,"4500,5",P-1',
          'Bobinas,Coberturas Aluzinc,Factura,F001-00012345,03/08/2026,20100000001,USD,"3,75",Contado,,,18,Segunda,,,,,,"3,10",ALZ-ROJO,,"0,30",1220,3000,',
          'Gasto,Servicios,Boleta,B001-9,05/08/2026,20100000002,PEN,,Contado,,,0,,,,Luz,1,NIU,150,,,,,,',
        ),
      ),
    );
    expect(parsed.rows).toBe(3);
    expect(parsed.documents).toHaveLength(2);
    const [coil, expense] = parsed.documents;
    // El 3 de agosto, no el 8 de marzo (D-152: SheetJS leía M/D/Y).
    expect(coil).toMatchObject({
      key: '20100000001|FACTURA|F001-00012345',
      series: 'F001',
      number: '00012345',
      issueDate: '2026-08-03',
      exchangeRate: '3,75',
      notes: 'Primera · Segunda',
    });
    expect(coil?.lines.map((l) => [l.rowNumber, l.qty, l.externalCode])).toEqual([
      [2, '4500,5', 'P-1'],
      [3, '3000', ''],
    ]);
    expect(expense).toMatchObject({ series: 'B001', number: '9', issueDate: '2026-08-05' });
    expect(expense?.lines[0]).toMatchObject({ description: 'Luz', qty: '1', unit: 'NIU' });
    expect(parsed.headerConflicts.size).toBe(0);
  });

  it('una fila que no repite la cabecera y una bobina con KG ≠ CANTIDAD se reportan', () => {
    const parsed = parsePurchaseRows(
      parseSpreadsheet(
        csv(
          'Bobinas,Drywall,Factura,F001-1,03/08/2026,20100000001,PEN,,Contado,,,18,,,,,100,,3,GALV,,0.45,120,200,',
          'Bobinas,Drywall,Factura,F001-1,04/08/2026,20100000001,PEN,,Contado,,,18,,,,,,,3,GALV,,0.45,120,300,',
        ),
      ),
    );
    expect(parsed.headerConflicts.get('20100000001|FACTURA|F001-1')).toEqual([
      'Fila 2: KG y CANTIDAD no coinciden; en una bobina la cantidad son los kilos: se tomó KG',
      'Fila 3: trae FECHA DE EMISIÓN distinto de la primera fila del comprobante: se tomó el de la primera fila',
    ]);
    // KG manda en una bobina.
    expect(parsed.documents[0]?.lines[0]?.qty).toBe('200');
  });

  it('sin una columna obligatoria rechaza el archivo diciendo cuál', () => {
    const raws = [{ 'TIPO DE COMPRA': 'Bobinas' }];
    expect(() => parsePurchaseRows(raws)).toThrow(BadRequestException);
    expect(() => parsePurchaseRows(raws)).toThrow(/LÍNEA DE NEGOCIO/);
  });

  it('claves y fechas', () => {
    expect(documentKeyOf(' 20100000001 ', 'factura', 'f001 - 12')).toBe(
      '20100000001|FACTURA|F001-12',
    );
    expect(documentKeyOf('1', 'nota', 'X')).toBe('1|NOTA|X');
    expect(issueDateOf('31/02/2026')).toBe('31/02/2026');
    expect(issueDateOf('2026-08-03')).toBe('2026-08-03');
  });
});

describe('referencias de la carga inicial (D-352)', () => {
  it('saca la factura de la nota de la carga inicial', () => {
    expect(
      referenceOf(
        'Saldo inicial de inventario · factura ref: F001-13071 · fecha ref: 2026-04-01 · código origen: X',
      ),
    ).toBe('F001-13071');
    expect(
      referenceOf('Saldo inicial de inventario · sin factura de referencia · fecha ref: x'),
    ).toBeNull();
    expect(referenceOf(null)).toBeNull();
  });

  it('indexa bobinas y SKU por la forma comparable de la referencia', async () => {
    const db = {
      coil: {
        findMany: jest.fn().mockResolvedValue([
          {
            code: 'BOB-1',
            notes: 'Saldo inicial de inventario · factura ref: F001-0013071 · fecha ref: x',
          },
          { code: 'BOB-2', notes: 'Saldo inicial de inventario · factura ref: f001-13071' },
        ]),
      },
      inventoryMovement: {
        findMany: jest.fn().mockResolvedValue([
          {
            itemId: 'p-1',
            notes: 'Saldo inicial de inventario · factura ref: E001-5 · fecha ref: x',
          },
        ]),
      },
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'p-1', sku: 'UPVC1' }]) },
    } as unknown as Prisma.TransactionClient;
    const refs = await initialLoadReferencesOf(db);
    expect(refs.get('F001-13071')).toEqual(['BOB-1', 'BOB-2']);
    expect(refs.get('E001-5')).toEqual(['UPVC1']);
    expect(
      (db as unknown as { inventoryMovement: { findMany: jest.Mock } }).inventoryMovement.findMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ itemType: InventoryItemType.PRODUCT }),
      }),
    );
  });
});

describe('la plantilla de ejemplo (docs/plantillas/importar-compras-ejemplo.xlsx)', () => {
  it('se lee entera: cuatro tipos, fechas como texto DD/MM/AAAA y las dos bobinas en un comprobante', () => {
    const file = readFileSync(
      `${__dirname}/../../../../docs/plantillas/importar-compras-ejemplo.xlsx`,
    );
    const parsed = parsePurchaseRows(parseSpreadsheet(file));
    expect(
      parsed.documents.map((d) => [d.type, d.series, d.number, d.issueDate, d.lines.length]),
    ).toEqual([
      ['Bobinas', 'F001', '00004567', '2026-09-15', 2],
      ['Producto terminado', 'F002', '00000891', '2026-09-18', 1],
      ['Servicio', 'E001', '000123', '2026-09-16', 1],
      ['Gasto', 'B001', '00045678', '2026-09-20', 1],
    ]);
    expect(parsed.documents[0]?.lines[0]).toMatchObject({
      qty: '4520,5',
      thicknessMm: '0,30',
      externalCode: 'PR-88121',
    });
    expect(parsed.headerConflicts.size).toBe(0);
  });
});
