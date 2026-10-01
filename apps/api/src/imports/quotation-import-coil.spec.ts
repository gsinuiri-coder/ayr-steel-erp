import { FinishKind, Prisma } from '@prisma/client';
import { QUOTATION_IMPORT_COLUMNS } from '@ayr/shared';
import type { CustomersService } from '../customers/customers.service';
import type { DocumentLookupService } from '../customers/document-lookup.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { QuotationsService } from '../sales/quotations.service';
import { QuotationImportService, readPaperLines } from './quotation-import.service';

/**
 * RF-S4b (R1/R2) en el importador, con el archivo de agosto en miniatura y una base falsa:
 * un código de bobina se resuelve al **pool**, no al producto suelto del mismo código; el
 * importe, el IGV y el precio de venta del papel viajan tal cual cuando cuadran; y `confirm`
 * manda a la cotización la bobina elegida y los tres importes.
 */

jest.mock('../production/production-assignments', () => ({
  findLiveStripAssignments: jest.fn().mockResolvedValue([]),
}));
jest.mock('../sales/reserved-ledger', () => ({
  reservedByItem: jest.fn().mockResolvedValue(new Map()),
}));

const D = (v: string) => new Prisma.Decimal(v);
const C = QUOTATION_IMPORT_COLUMNS;
const HEADERS = [
  C.issueDate,
  C.docType,
  C.documentKey,
  C.customer,
  C.currency,
  C.exchangeRate,
  C.adjustedDocument,
  C.sku,
  C.productName,
  C.unit,
  C.qty,
  C.netAmount,
  C.igv,
  C.totalAmount,
];

interface Row {
  key?: string;
  sku: string;
  name?: string;
  unit?: string;
  qty: string;
  net: string;
  igv?: string;
  total?: string;
  docType?: string;
  currency?: string;
  rate?: string;
}
function csv(rows: Row[]): Buffer {
  const body = rows.map((r) =>
    [
      '07/08/2026',
      r.docType ?? 'Factura',
      r.key ?? 'FFA1-1350',
      '20601234567 - CLIENTE SAC',
      r.currency ?? 'Soles',
      r.rate ?? '',
      '',
      r.sku,
      r.name ?? '',
      r.unit ?? 'KILOGRAMO',
      r.qty,
      r.net,
      r.igv ?? '',
      r.total ?? '',
    ].join(','),
  );
  return Buffer.from([HEADERS.join(','), ...body].join('\n'), 'utf8');
}

const coilRow = (id: string, balance: string) => ({
  id,
  code: `SALDO-${id}`,
  widthMm: D('1200'),
  thicknessMm: D('0.38'),
  finish: { code: 'ALZ-AZUL-5002', kind: FinishKind.PREPINTADO, color: { code: 'AZUL' } },
  balance,
});

function build(opts: { coils?: ReturnType<typeof coilRow>[]; canonical?: boolean } = {}) {
  const coils = opts.coils ?? [coilRow('c-1', '4194')];
  const looseProduct = {
    id: 'p-loose',
    sku: 'BOB38AZUL',
    name: 'Suelto',
    unit: 'KGM',
    roofingKind: null,
  };
  const prisma = {
    customer: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'cus-1', docNumber: '20601234567', name: 'CLIENTE SAC' }]),
    },
    product: {
      findMany: jest.fn(
        ({ where }: { where: { businessLineId?: string; sku: { in: string[] } } }) => {
          // findCoilSaleProducts (con línea) devuelve el canónico; el preview de filas comunes, el suelto.
          if (where.businessLineId !== undefined) {
            return Promise.resolve(
              opts.canonical === false
                ? []
                : [
                    {
                      id: 'p-canon',
                      sku: 'BOB038AZUL',
                      name: 'Bobina Azul 0.38',
                      businessLineId: 'bl-t',
                    },
                  ],
            );
          }
          return Promise.resolve(where.sku.in.includes('BOB38AZUL') ? [looseProduct] : []);
        },
      ),
    },
    quotation: { findMany: jest.fn().mockResolvedValue([]) },
    color: { findMany: jest.fn().mockResolvedValue([{ code: 'AZUL' }, { code: 'ROJO' }]) },
    businessLine: { findUnique: jest.fn().mockResolvedValue({ id: 'bl-t' }) },
    coil: {
      findMany: jest.fn(({ where }: { where: { id?: unknown } }) =>
        Promise.resolve(where.id === undefined ? coils : coils.map((c) => ({ ...c }))),
      ),
    },
    inventoryBalance: {
      findMany: jest
        .fn()
        .mockResolvedValue(coils.map((c) => ({ itemId: c.id, qty: D(c.balance) }))),
    },
    quotationItem: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const quotations = { createInTx: jest.fn().mockResolvedValue('q-new') };
  const service = new QuotationImportService(
    prisma as unknown as PrismaService,
    quotations as unknown as QuotationsService,
    {} as CustomersService,
    { lookup: jest.fn() } as unknown as DocumentLookupService,
  );
  return { service, prisma, quotations };
}

const BOB_AZUL: Row = {
  sku: 'BOB38AZUL',
  name: 'BOBINA ALUZINC AZUL 0.38 X 1200 RAL 5002',
  qty: '4194.0000000000',
  net: '12439.831',
  igv: '2239.169',
  total: '14679.000',
};

describe('QuotationImportService.preview — filas de bobina (R1)', () => {
  it('BOB38AZUL resuelve al canónico y se ata sola a la única bobina del pool', async () => {
    const { service } = build();
    const { rows } = await service.preview('ventas.csv', csv([BOB_AZUL]));
    const [row] = rows;
    expect(row).toMatchObject({
      coilLine: true,
      productSku: 'BOB038AZUL',
      saleCoilId: 'c-1',
      coilPoolAvailableKg: '4194.000',
    });
    // Nunca el producto suelto que coincide letra por letra con el origen.
    expect(row?.productId).toBe('p-canon');
    expect(row?.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('con dos bobinas candidatas la fila queda para elegir', async () => {
    const { service } = build({ coils: [coilRow('c-1', '5000'), coilRow('c-2', '6000')] });
    const [row] = (await service.preview('v.csv', csv([BOB_AZUL]))).rows;
    expect(row?.saleCoilId).toBeNull();
    expect(row?.coilCandidates).toHaveLength(2);
    expect(row?.issues.map((i) => i.message).join(' ')).toMatch(/2 bobinas/);
  });

  it('sin bobina con esa cantidad, la fila queda bloqueada con el disponible del pool', async () => {
    const { service } = build({ coils: [coilRow('c-1', '100')] });
    const [row] = (await service.preview('v.csv', csv([BOB_AZUL]))).rows;
    expect(row?.coilCandidates).toEqual([]);
    expect(row?.issues.map((i) => i.message).join(' ')).toMatch(/ninguna bobina libre.*100\.000/);
  });

  it('un color que el catálogo no tiene queda para revisión, sin crear nada', async () => {
    const { service } = build();
    const [row] = (
      await service.preview('v.csv', csv([{ ...BOB_AZUL, sku: 'BOB38MORADO', name: '' }]))
    ).rows;
    expect(row?.coilLine).toBe(true);
    expect(row?.productId).toBeNull();
    expect(row?.issues.map((i) => i.message).join(' ')).toMatch(/No se pudo interpretar/);
  });

  it('las bobinas del pool sin producto de venta piden revisar el catálogo', async () => {
    const { service } = build({ canonical: false });
    const [row] = (await service.preview('v.csv', csv([BOB_AZUL]))).rows;
    expect(row?.issues.map((i) => i.message).join(' ')).toMatch(/no tienen producto de venta/);
  });

  it('dos filas que caen en la misma bobina única quedan las dos para revisión', async () => {
    const { service } = build();
    const { rows } = await service.preview(
      'v.csv',
      csv([BOB_AZUL, { ...BOB_AZUL, key: 'FFA1-1351' }]),
    );
    expect(rows.map((r) => r.saleCoilId)).toEqual([null, null]);
    expect(rows[0]?.issues.map((i) => i.message).join(' ')).toMatch(/misma bobina/);
  });
});

describe('QuotationImportService.preview — importes del papel (R2)', () => {
  it('guarda valor, IGV y precio de venta del papel cuando cuadran', async () => {
    const { service } = build();
    const [row] = (await service.preview('v.csv', csv([BOB_AZUL]))).rows;
    // D-255 (decisión del dueño): el trío normalizado a dos decimales, IGV como la resta.
    expect(row).toMatchObject({
      netAmountPen: '12439.8300',
      igvAmountPen: '2239.1700',
      totalAmountPen: '14679.0000',
    });
  });

  it('FFA1-1350 real: IGV con cinco decimales que no suma exacto → 12439.83 / 2239.17 / 14679.00', async () => {
    const { service } = build();
    const [row] = (await service.preview('v.csv', csv([{ ...BOB_AZUL, igv: '2239.16958' }]))).rows;
    expect(row).toMatchObject({
      netAmountPen: '12439.8300',
      igvAmountPen: '2239.1700',
      totalAmountPen: '14679.0000',
    });
  });

  it('P2-1: el importador y el barrido leen igual un valor de cinco decimales (10 000.00495)', async () => {
    // Antes el importador redondeaba el valor a cuatro decimales (10 000.0050) antes de
    // `paperAmounts`, que lo volvía a redondear a dos (10 000.01): el IGV de la resta quedaba a
    // 0.0118 del 18 % y el trío se descartaba, mientras el barrido lo aceptaba con 10 000.00.
    const { service } = build();
    const odd = { ...BOB_AZUL, net: '10000.00495', igv: '1800.00', total: '11800.00' };
    const [row] = (await service.preview('v.csv', csv([odd]))).rows;
    const [line] = readPaperLines(csv([odd]));
    const trio = {
      netAmountPen: '10000.0000',
      igvAmountPen: '1800.0000',
      totalAmountPen: '11800.0000',
    };
    expect(row).toMatchObject(trio);
    expect(line).toMatchObject(trio);
  });

  it('una suma que se separa del total en 0.02 descarta el trío', async () => {
    const { service } = build();
    const [row] = (await service.preview('v.csv', csv([{ ...BOB_AZUL, igv: '2239.189' }]))).rows;
    expect(row?.netAmountPen).toBe('12439.8310');
    expect(row?.igvAmountPen).toBe('');
  });

  it('si el trío no cuadra, viaja solo el valor de venta', async () => {
    const { service } = build();
    const [row] = (await service.preview('v.csv', csv([{ ...BOB_AZUL, igv: '1.00' }]))).rows;
    expect(row?.netAmountPen).toBe('12439.8310');
    expect(row?.igvAmountPen).toBe('');
    expect(row?.totalAmountPen).toBe('');
  });

  it('en dólares no se cuadra el trío: manda el valor de venta convertido', async () => {
    const { service } = build();
    const [row] = (
      await service.preview('v.csv', csv([{ ...BOB_AZUL, currency: 'Dólares', rate: '3.7' }]))
    ).rows;
    expect(row?.netAmountPen).toBe('46027.3747');
    expect(row?.igvAmountPen).toBe('');
  });

  it('P14 §3.5: el unitario viaja con sus decimales y el importe del papel no cambia', async () => {
    // El caso del dueño: 146 × 16.28928 = 2 378.23488. Antes el unitario salía cortado a cuatro
    // (16.2893), y la fila editada se recalculaba a 2 378.2378.
    const { service } = build();
    const [row] = (
      await service.preview('v.csv', csv([{ sku: 'ZZZ', qty: '146', net: '2378.23488' }]))
    ).rows;
    expect(row).toMatchObject({
      qty: '146.000',
      unitPricePen: '16.28928',
      // La fila intacta sigue viajando con el importe del papel, como siempre.
      netAmountPen: '2378.2349',
    });
  });

  it('P14 §3.5: un unitario de cuatro decimales justos se sigue viendo igual', async () => {
    const { service } = build();
    const [row] = (await service.preview('v.csv', csv([{ sku: 'ZZZ', qty: '10', net: '1000' }])))
      .rows;
    expect(row).toMatchObject({ unitPricePen: '100.0000', netAmountPen: '1000.0000' });
  });

  it('una fila común (no bobina) sigue resolviendo por su SKU exacto', async () => {
    const { service } = build();
    const { rows } = await service.preview(
      'v.csv',
      csv([{ sku: 'ZZZ', name: 'algo', qty: '1', net: '10' }]),
    );
    expect(rows[0]?.coilLine).toBe(false);
    expect(rows[0]?.issues.map((i) => i.message).join(' ')).toMatch(/no está en el catálogo/);
  });
});

describe('QuotationImportService.confirm — lo que viaja a la cotización', () => {
  it('manda la bobina elegida y los tres importes del papel', async () => {
    const { service, quotations } = build();
    const tx = {
      $executeRawUnsafe: jest.fn(),
      $executeRaw: jest.fn(),
      quotation: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ seq: 2 }),
      },
    };
    (service as unknown as { prisma: { $transaction: unknown } }).prisma.$transaction = (
      fn: (t: unknown) => Promise<unknown>,
    ) => fn(tx);
    const result = await service.confirm({ id: 'u-1' } as never, {
      rows: [
        {
          rowNumber: 1,
          documentKey: 'FFA1-1350',
          issueDate: '2026-08-07',
          customerId: '11111111-1111-4111-8111-111111111111',
          productId: '22222222-2222-4222-8222-222222222222',
          qty: '4194.000',
          unitPricePen: '2.9661',
          netAmountPen: '12439.8310',
          igvAmountPen: '2239.1690',
          totalAmountPen: '14679.0000',
          saleCoilId: '33333333-3333-4333-8333-333333333333',
        },
      ],
    });
    expect(result).toMatchObject({ quotations: 1, rows: 1, codes: ['COT-000002'] });
    const [, , input, options] = quotations.createInTx.mock.calls[0] as [
      unknown,
      unknown,
      { items: Record<string, unknown>[] },
      { enforcePriceFloor: boolean; exactAmounts: { documentLabel: string } },
    ];
    expect(input.items[0]).toMatchObject({
      saleCoilId: '33333333-3333-4333-8333-333333333333',
      netAmountPen: '12439.8310',
      igvAmountPen: '2239.1690',
      totalAmountPen: '14679.0000',
    });
    expect(options).toMatchObject({ enforcePriceFloor: false });
  });

  it('una fila editada (sin importes) no manda IGV ni total', async () => {
    const { service, quotations } = build();
    const tx = {
      $executeRawUnsafe: jest.fn(),
      $executeRaw: jest.fn(),
      quotation: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ seq: 3 }),
      },
    };
    (service as unknown as { prisma: { $transaction: unknown } }).prisma.$transaction = (
      fn: (t: unknown) => Promise<unknown>,
    ) => fn(tx);
    await service.confirm({ id: 'u-1' } as never, {
      rows: [
        {
          rowNumber: 1,
          documentKey: 'FFA1-1351',
          issueDate: '2026-08-07',
          customerId: '11111111-1111-4111-8111-111111111111',
          productId: '22222222-2222-4222-8222-222222222222',
          qty: '10.000',
          unitPricePen: '2.0000',
        },
      ],
    });
    const [, , input] = quotations.createInTx.mock.calls[0] as [
      unknown,
      unknown,
      { items: Record<string, unknown>[] },
    ];
    expect(input.items[0]).not.toHaveProperty('igvAmountPen');
    expect(input.items[0]).not.toHaveProperty('saleCoilId');
    expect(input.items[0]).not.toHaveProperty('netAmountPen');
  });

  it('P14 §3.5: la fila editada manda el unitario entero, sin cortarlo a cuatro', async () => {
    const { service, quotations } = build();
    const tx = {
      $executeRawUnsafe: jest.fn(),
      $executeRaw: jest.fn(),
      quotation: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ seq: 4 }),
      },
    };
    (service as unknown as { prisma: { $transaction: unknown } }).prisma.$transaction = (
      fn: (t: unknown) => Promise<unknown>,
    ) => fn(tx);
    await service.confirm({ id: 'u-1' } as never, {
      rows: [
        {
          rowNumber: 1,
          documentKey: 'FFA1-0146',
          issueDate: '2026-08-07',
          customerId: '11111111-1111-4111-8111-111111111111',
          productId: '22222222-2222-4222-8222-222222222222',
          qty: '146.000',
          unitPricePen: '16.28928',
        },
      ],
    });
    const [, , input] = quotations.createInTx.mock.calls[0] as [
      unknown,
      unknown,
      { items: Record<string, unknown>[] },
    ];
    // El alta recalcula `redondeo(146 × 16.28928)` = 2 378.2349 (ver quotation-import.spec.ts).
    expect(input.items[0]).toMatchObject({ qty: '146.000', unitPricePen: '16.28928' });
    expect(input.items[0]).not.toHaveProperty('netAmountPen');
  });
});

describe('readPaperLines', () => {
  it('lee el papel igual que el preview: cantidad, importe y trío que cuadra', () => {
    const [line] = readPaperLines(csv([BOB_AZUL]));
    expect(line).toMatchObject({
      documentKey: 'FFA1-1350',
      rawSku: 'BOB38AZUL',
      qty: '4194.000',
      netAmountPen: '12439.8300',
      igvAmountPen: '2239.1700',
      totalAmountPen: '14679.0000',
      excluded: false,
    });
  });

  it('un trío que no cuadra deja IGV y total en null', () => {
    const [line] = readPaperLines(csv([{ ...BOB_AZUL, total: '20000' }]));
    expect(line?.igvAmountPen).toBeNull();
    expect(line?.totalAmountPen).toBeNull();
  });

  it('una nota de crédito queda excluida', () => {
    const [line] = readPaperLines(csv([{ ...BOB_AZUL, docType: 'Nota de crédito' }]));
    expect(line?.excluded).toBe(true);
  });

  it('en dólares convierte el valor con el tipo de cambio y no cuadra el trío', () => {
    const [line] = readPaperLines(csv([{ ...BOB_AZUL, currency: 'Dólares', rate: '3.7' }]));
    expect(line?.netAmountPen).toBe('46027.3747');
    expect(line?.igvAmountPen).toBeNull();
  });

  it('dólares sin tipo de cambio no tiene importe legible', () => {
    const [line] = readPaperLines(csv([{ ...BOB_AZUL, currency: 'Dólares' }]));
    expect(line?.netAmountPen).toBeNull();
  });
});

describe('D-368 — comprobante con cotización relacionada', () => {
  const MARK = 'Factura externa: ';

  it('el preview marca la fila como error y busca el número exacto, sin las anuladas', async () => {
    const { service, prisma } = build();
    prisma.quotation.findMany.mockResolvedValue([{ notes: `${MARK}FFA1-1350\nNota del vendedor` }]);
    const [row] = (await service.preview('v.csv', csv([BOB_AZUL]))).rows;
    const issue = row?.issues.find((i) => i.field === 'row');
    expect(issue).toMatchObject({ severity: 'error' });
    expect(issue?.message).toMatch(/cotización relacionada/);
    const [[{ where }]] = prisma.quotation.findMany.mock.calls as [
      [{ where: Record<string, unknown> }],
    ];
    expect(where).toEqual({
      status: { not: 'CANCELLED' },
      OR: [{ notes: `${MARK}FFA1-1350` }, { notes: { startsWith: `${MARK}FFA1-1350\n` } }],
    });
  });

  it('una cotización de FFA1-13500 no vuelve relacionada a FFA1-1350', async () => {
    const { service, prisma } = build();
    prisma.quotation.findMany.mockResolvedValue([{ notes: `${MARK}FFA1-13500` }]);
    const [row] = (await service.preview('v.csv', csv([BOB_AZUL]))).rows;
    expect(row?.issues.some((i) => i.message.includes('cotización relacionada'))).toBe(false);
  });

  it('confirm revalida dentro de la transacción y no crea el documento', async () => {
    const { service, quotations } = build();
    const findFirst = jest.fn().mockResolvedValue({ seq: 7 });
    const tx = {
      $executeRawUnsafe: jest.fn(),
      $executeRaw: jest.fn(),
      quotation: { findFirst, findUniqueOrThrow: jest.fn() },
    };
    (service as unknown as { prisma: { $transaction: unknown } }).prisma.$transaction = (
      fn: (t: unknown) => Promise<unknown>,
    ) => fn(tx);
    await expect(
      service.confirm({ id: 'u-1' } as never, {
        rows: [
          {
            rowNumber: 1,
            documentKey: 'FFA1-1350',
            issueDate: '2026-08-07',
            customerId: '11111111-1111-4111-8111-111111111111',
            productId: '22222222-2222-4222-8222-222222222222',
            qty: '1.000',
            unitPricePen: '10.0000',
          },
        ],
      }),
    ).rejects.toMatchObject({
      response: {
        errors: { 'FFA1-1350': [expect.stringMatching(/COT-000007/)] },
      },
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        status: { not: 'CANCELLED' },
        OR: [{ notes: `${MARK}FFA1-1350` }, { notes: { startsWith: `${MARK}FFA1-1350\n` } }],
      },
      select: { seq: true },
    });
    expect(quotations.createInTx).not.toHaveBeenCalled();
    // El lock por número se toma antes de revalidar (dos confirmaciones simultáneas).
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('la foto de duplicados agrupa por número y solo devuelve dos o más no anuladas', async () => {
    const { service, prisma } = build();
    prisma.quotation.findMany.mockResolvedValue([
      // Re-cotizado: una anulada y una viva no es un duplicado.
      { seq: 1, status: 'CONFIRMED', notes: `${MARK}F001-1` },
      { seq: 2, status: 'CANCELLED', notes: `${MARK}F001-1\nre-cotizada` },
      { seq: 3, status: 'CONFIRMED', notes: `${MARK}F001-12` },
      // Duplicado de verdad: dos vivas; la anulada va como contexto.
      { seq: 4, status: 'EMITTED', notes: `${MARK}F001-2` },
      { seq: 5, status: 'CONFIRMED', notes: `${MARK}F001-2` },
      { seq: 6, status: 'CANCELLED', notes: `${MARK}F001-2` },
    ]);
    await expect(service.duplicateInvoices()).resolves.toEqual([
      {
        invoice: 'F001-2',
        quotations: [
          { code: 'COT-000004', status: 'EMITTED' },
          { code: 'COT-000005', status: 'CONFIRMED' },
          { code: 'COT-000006', status: 'CANCELLED' },
        ],
      },
    ]);
  });
});
