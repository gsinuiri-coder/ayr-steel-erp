import type { Prisma } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import * as XLSX from 'xlsx';
import { reviewBackdatedLoad, type LoadReview, type Sheets } from './backdated-load';
import {
  loadReviewContext,
  namedItems,
  readLoadSheets,
  reviewMarkdown,
} from './backdated-load-context';
import { planLoadOps } from './backdated-load-ops';

/** cc63/cc64: la lectura del plan de carga y lo que la revisión le pide a la base. */
const empty = (): Sheets => ({
  purchases: [],
  sales: [],
  production: [],
  dispatches: [],
  collections: [],
  supplierPayments: [],
});

/** Un libro con una hoja por nombre; `cellDates` decide si la fecha viaja como fecha o serial. */
function book(sheets: Record<string, Record<string, unknown>[]>, cellDates = true): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { cellDates }), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates }) as Buffer;
}

describe('namedItems (cc63/cc64)', () => {
  it('junta los SKU de todas las hojas y las bobinas de compras (código externo) y producción', () => {
    const sheets = empty();
    sheets.purchases = [
      { SKU: 'BOB-SKU', 'CÓDIGO EXTERNO': 'EXT-1' },
      { SKU: '', 'CÓDIGO EXTERNO': '' },
    ];
    sheets.sales = [{ 'CÓDIGO PRODUCTO': 'COB-1' }];
    sheets.production = [
      { 'CÓDIGO PRODUCTO': 'COB-1', 'CÓDIGO BOBINA': 'BOB-001' },
      { 'CÓDIGO PRODUCTO': 'ACC-1', 'CÓDIGO BOBINA': '' },
    ];
    sheets.dispatches = [{ 'CÓDIGO PRODUCTO': 'PERFIL-1' }];
    const named = namedItems(sheets);
    expect([...named.skus].sort()).toEqual(['ACC-1', 'BOB-SKU', 'COB-1', 'PERFIL-1']);
    expect([...named.coils].sort()).toEqual(['BOB-001', 'EXT-1']);
  });
});

describe('loadReviewContext (cc63/cc64)', () => {
  it('lee el kardex de cada producto y bobina nombrados, la línea, los largos y los clientes', async () => {
    const movement = (id: string, type: string, qty: string, date: string) => ({
      id,
      type,
      qty: new Decimal(qty),
      operationDate: new Date(`${date}T00:00:00.000Z`),
      reversalOfId: null,
    });
    const tx = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'p-cob',
            sku: 'COB-1',
            unit: 'MTR',
            roofingKind: 'A_MEDIDA',
            businessLine: { code: 'COBERTURAS' },
          },
          {
            id: 'p-dry',
            sku: 'PERFIL-1',
            unit: 'NIU',
            roofingKind: null,
            businessLine: { code: 'DRYWALL' },
          },
        ]),
      },
      coil: {
        findMany: jest.fn().mockResolvedValue([
          // Se reconoce por el código externo; el código interno no lo nombra el plan.
          { id: 'c-1', code: 'BOB-INTERNA', externalCode: 'EXT-1' },
          { id: 'c-2', code: 'BOB-001', externalCode: null },
        ]),
      },
      inventoryMovement: {
        findMany: jest
          .fn()
          .mockImplementation((args: { where: { itemId: string } }) =>
            Promise.resolve(
              args.where.itemId === 'p-cob'
                ? [
                    movement('m1', 'IN', '10', '2026-10-01'),
                    movement('m2', 'OUT', '4', '2026-10-05'),
                  ]
                : args.where.itemId === 'c-2'
                  ? [movement('m3', 'IN', '500', '2026-09-01')]
                  : [],
            ),
          ),
      },
      customer: {
        findMany: jest.fn().mockResolvedValue([{ docNumber: '20100000001' }]),
      },
    };
    const sheets = empty();
    sheets.purchases = [{ SKU: 'COB-1', 'CÓDIGO EXTERNO': 'EXT-1' }];
    sheets.sales = [
      { 'CÓDIGO PRODUCTO': 'PERFIL-1', CLIENTE: '20100000001 - Cliente uno' },
      { 'CÓDIGO PRODUCTO': 'PERFIL-1', CLIENTE: '20100000001 - Cliente uno' },
      { 'CÓDIGO PRODUCTO': 'PERFIL-1', CLIENTE: '12345678 - Persona' },
      { 'CÓDIGO PRODUCTO': 'PERFIL-1', CLIENTE: 'Sin documento' },
    ];
    sheets.production = [{ 'CÓDIGO PRODUCTO': 'COB-1', 'CÓDIGO BOBINA': 'BOB-001' }];

    const ctx = await loadReviewContext(tx as unknown as Prisma.TransactionClient, sheets, {
      loadDate: '2026-10-21',
      historicalFloor: '2026-08-01',
    });

    expect(tx.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sku: { in: ['COB-1', 'PERFIL-1'] } } }),
    );
    expect(tx.coil.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { not: 'CANCELLED' },
          OR: [
            { code: { in: ['EXT-1', 'BOB-001'] } },
            { externalCode: { in: ['EXT-1', 'BOB-001'] } },
          ],
        },
      }),
    );
    // Los documentos de cliente, sin repetir; el texto sin documento no cuenta.
    expect(tx.customer.findMany).toHaveBeenCalledWith({
      where: { docNumber: { in: ['20100000001', '12345678'] } },
      select: { docNumber: true },
    });
    expect(ctx.loadDate).toBe('2026-10-21');
    expect(ctx.historicalFloor).toBe('2026-08-01');
    expect([...ctx.products]).toEqual(['COB-1', 'PERFIL-1']);
    expect([...ctx.coils].sort()).toEqual(['BOB-001', 'EXT-1']);
    expect([...(ctx.customers ?? [])]).toEqual(['20100000001']);
    expect(ctx.productInfo?.get('COB-1')).toEqual({ drywall: false, needsLengths: true });
    expect(ctx.productInfo?.get('PERFIL-1')).toEqual({ drywall: true, needsLengths: false });
    const cob = ctx.kardex.get('PRODUCT:COB-1') ?? [];
    expect(cob.map((r) => [r.date, r.delta.toString()])).toEqual([
      ['2026-10-01', '10'],
      ['2026-10-05', '-4'],
    ]);
    expect(ctx.kardex.get('PRODUCT:PERFIL-1')).toEqual([]);
    expect(ctx.kardex.get('COIL:EXT-1')).toEqual([]);
    expect(ctx.kardex.get('COIL:BOB-001')?.map((r) => r.delta.toString())).toEqual(['500']);
    // El código interno de la bobina no lo nombra el plan: no entra al contexto.
    expect(ctx.kardex.has('COIL:BOB-INTERNA')).toBe(false);
  });
});

describe('readLoadSheets (cc63)', () => {
  it('lee cada hoja por su nombre, deja vacías las que faltan y descarta las filas en blanco', () => {
    const buffer = book({
      Compras: [
        { 'RUC PROVEEDOR': '20100000001', 'SERIE-NÚMERO': 'F001-1', CANTIDAD: 10 },
        { 'RUC PROVEEDOR': '', 'SERIE-NÚMERO': '', CANTIDAD: '' },
        { 'RUC PROVEEDOR': '20100000001', 'SERIE-NÚMERO': 'F001-2', CANTIDAD: 5 },
      ],
      Cobros: [{ 'SERIE - NÚMERO': 'F930-1', MONTO: '118' }],
      'Otra hoja': [{ X: 1 }],
    });
    const sheets = readLoadSheets(buffer);
    expect(sheets.purchases.map((r) => r['SERIE-NÚMERO'])).toEqual(['F001-1', 'F001-2']);
    expect(sheets.purchases[1]?.CANTIDAD).toBe(5);
    expect(sheets.collections).toEqual([{ 'SERIE - NÚMERO': 'F930-1', MONTO: '118' }]);
    expect(sheets.sales).toEqual([]);
    expect(sheets.production).toEqual([]);
    expect(sheets.dispatches).toEqual([]);
    expect(sheets.supplierPayments).toEqual([]);
    // SheetJS deja el número de fila real: la fila en blanco no corre la numeración.
    expect(planLoadOps(sheets).ops.map((o) => o.rows)).toEqual([
      [{ sheet: 'Compras', row: 2 }],
      [{ sheet: 'Compras', row: 4 }],
      [{ sheet: 'Cobros', row: 2 }],
    ]);
  });

  // Autorrevisión de cc64 (P3-22): el Excel real del cliente trae celdas de fecha, no texto.
  describe.each([
    ['celdas de fecha (cellDates)', true],
    ['seriales de Excel', false],
  ])('con fechas reales: %s', (_label, cellDates) => {
    const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);
    const buffer = () =>
      book(
        {
          Compras: [
            {
              'TIPO DE COMPRA': 'PRODUCTO TERMINADO',
              'SERIE-NÚMERO': 'F001-1',
              'FECHA DE EMISIÓN': d(2026, 10, 14),
              'RUC PROVEEDOR': '20100000001',
              SKU: 'PERFIL-1',
              CANTIDAD: 100,
              'FECHA DE RECEPCIÓN': d(2026, 10, 14),
            },
          ],
          Ventas: [
            {
              'F. EMISIÓN': d(2026, 10, 15),
              'TIPO COMPROBANTE': 'FACTURA',
              'SERIE - NÚMERO': 'FFA1-1',
              CLIENTE: '20100000002 - Cliente',
              'CÓDIGO PRODUCTO': 'PERFIL-1',
              CANTIDAD: 10,
              'VALOR DE VENTA': 100,
              'PRECIO DE VENTA': 118,
              'CONDICIÓN DE PAGO': 'CREDITO',
              VENCIMIENTO: d(2026, 11, 14),
            },
          ],
          Producción: [
            {
              'SERIE - NÚMERO': 'FFA1-1',
              FECHA: d(2026, 10, 16),
              'CÓDIGO PRODUCTO': 'COB-1',
              CANTIDAD: 1,
            },
          ],
          Despachos: [
            {
              'SERIE - NÚMERO': 'FFA1-1',
              FECHA: d(2026, 10, 17),
              'CÓDIGO PRODUCTO': 'PERFIL-1',
              CANTIDAD: 10,
            },
          ],
          Cobros: [{ 'SERIE - NÚMERO': 'FFA1-1', FECHA: d(2026, 10, 18), MONTO: 118 }],
          Pagos: [
            {
              'RUC PROVEEDOR': '20100000001',
              'SERIE-NÚMERO': 'F001-1',
              FECHA: d(2026, 10, 19),
              MONTO: 50,
            },
          ],
        },
        cellDates,
      );

    it('las operaciones salen con el día calendario de la celda', () => {
      const { ops } = planLoadOps(readLoadSheets(buffer()));
      expect(ops.map((o) => [o.step, o.date])).toEqual([
        ['purchases', '2026-10-14'],
        ['sales', '2026-10-15'],
        ['orders', '2026-10-15'],
        ['production', '2026-10-16'],
        ['dispatches', '2026-10-17'],
        ['invoices', '2026-10-15'],
        ['collections', '2026-10-18'],
        ['supplierPayments', '2026-10-19'],
      ]);
      const purchase = ops.find((o) => o.step === 'purchases');
      expect(purchase?.step === 'purchases' && purchase.receivedDate).toBe('2026-10-14');
      const invoice = ops.find((o) => o.step === 'invoices');
      expect(invoice?.step === 'invoices' && invoice.dueDate).toBe('2026-11-14');
    });

    it('la revisión no marca ninguna fecha como inválida', () => {
      const review = reviewBackdatedLoad(readLoadSheets(buffer()), {
        loadDate: '2026-10-21',
        historicalFloor: '2026-08-01',
        kardex: new Map(),
        products: new Set(['PERFIL-1', 'COB-1']),
        coils: new Set(),
      });
      const dateIssues = [...review.errors, ...review.warnings].filter((e) =>
        /fecha|vencimiento/i.test(e.message),
      );
      expect(dateIssues).toEqual([]);
      expect(review.oldestIssue?.issueDate).toBe('2026-10-15');
    });
  });
});

describe('reviewMarkdown (cc63)', () => {
  const base = (): LoadReview => ({
    loadDate: '2026-10-21',
    order: ['Compras', 'Ventas'],
    counts: {
      purchases: 1,
      sales: 2,
      production: 0,
      dispatches: 0,
      collections: 0,
      supplierPayments: 0,
    },
    errors: [],
    warnings: [],
    recosts: [],
    movements: { planned: 3, rejected: 1 },
    oldestIssue: null,
  });

  it('un informe sin hallazgos', () => {
    expect(reviewMarkdown(base())).toBe(
      [
        '# Revisión previa de la carga atrasada',
        '',
        'Fecha de carga simulada: 2026-10-21. Movimientos de kardex: 3 (1 rechazados por D-652).',
        '',
        'Hojas: purchases 1 · sales 2 · production 0 · dispatches 0 · collections 0 · supplierPayments 0',
        'Sin comprobantes.',
        '',
        '## Orden de carga',
        '',
        '1. Compras',
        '2. Ventas',
        '',
        '## Errores (0)',
        '',
        '',
        '## Avisos (0)',
        '',
        '',
        '## Recosteos (0; máximo 0 filas)',
        '',
        '',
      ].join('\n'),
    );
  });

  it('errores con y sin fila, avisos, el comprobante más antiguo y los recosteos de mayor a menor', () => {
    const r = base();
    r.errors = [
      { sheet: 'Ventas', row: 3, message: 'falta el cliente' },
      { sheet: 'Plan', row: null, message: 'archivo vacío' },
    ];
    r.warnings = [{ sheet: 'Despachos', row: 2, message: 'sin modalidad' }];
    r.oldestIssue = { document: 'FFA1-1', issueDate: '2026-08-01', lastLoadDate: '2026-10-30' };
    r.recosts = [
      { sheet: 'Compras', row: 2, item: 'A', date: '2026-10-01', rowsAfter: 3, overLimit: false },
      {
        sheet: 'Producción',
        row: 4,
        item: 'B',
        date: '2026-10-02',
        rowsAfter: 900,
        overLimit: true,
      },
    ];
    const md = reviewMarkdown(r);
    expect(md).toContain('- Ventas fila 3: falta el cliente');
    expect(md).toContain('- Plan: archivo vacío');
    expect(md).toContain('## Avisos (1)');
    expect(md).toContain('- Despachos fila 2: sin modalidad');
    expect(md).toContain(
      'Comprobante más antiguo: FFA1-1 del 2026-08-01; se puede registrar hasta el 2026-10-30.',
    );
    expect(md).toContain('## Recosteos (2; máximo 900 filas)');
    const b = md.indexOf('- B el 2026-10-02 (Producción fila 4): 900 filas — PASA EL TOPE');
    const a = md.indexOf('- A el 2026-10-01 (Compras fila 2): 3 filas\n');
    expect(b).toBeGreaterThan(0);
    expect(a).toBeGreaterThan(b);
    // El orden del informe no altera la lista original.
    expect(r.recosts[0]?.item).toBe('A');
  });

  it('muestra como máximo los 50 recosteos más grandes', () => {
    const r = base();
    r.recosts = Array.from({ length: 60 }, (_, i) => ({
      sheet: 'Compras',
      row: i + 2,
      item: `I${String(i)}`,
      date: '2026-10-01',
      rowsAfter: i,
      overLimit: false,
    }));
    const lines = reviewMarkdown(r)
      .split('\n')
      .filter((l) => l.startsWith('- I'));
    expect(lines).toHaveLength(50);
    expect(lines[0]).toContain('I59');
    expect(lines.some((l) => l.startsWith('- I9 '))).toBe(false);
  });
});
