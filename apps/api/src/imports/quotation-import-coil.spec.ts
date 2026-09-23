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
    expect(row).toMatchObject({
      netAmountPen: '12439.8310',
      igvAmountPen: '2239.1690',
      totalAmountPen: '14679.0000',
    });
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
      quotation: { findUniqueOrThrow: jest.fn().mockResolvedValue({ seq: 2 }) },
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
      quotation: { findUniqueOrThrow: jest.fn().mockResolvedValue({ seq: 3 }) },
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
});

describe('readPaperLines', () => {
  it('lee el papel igual que el preview: cantidad, importe y trío que cuadra', () => {
    const [line] = readPaperLines(csv([BOB_AZUL]));
    expect(line).toMatchObject({
      documentKey: 'FFA1-1350',
      rawSku: 'BOB38AZUL',
      qty: '4194.000',
      netAmountPen: '12439.8310',
      igvAmountPen: '2239.1690',
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
