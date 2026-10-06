import * as XLSX from 'xlsx';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  LIST_XLSX_MAX_ROWS,
  purchaseExportQuerySchema,
  purchaseQuerySchema,
  Role,
  sum,
  type PurchaseListItemDto,
} from '@ayr/shared';
import { balancePen, purchasesXlsx } from './purchases-xlsx';
import { PurchasesService } from './purchases.service';

/**
 * cc26 M2 (D-provisional): el Excel de la lista de compras trae las mismas filas que la pantalla
 * —todas las páginas, en el mismo orden, también con «Solo con saldo» (filtro derivado, en
 * memoria)— y su fila de total es la suma en soles de esas filas. Los importes solo los recibe
 * el ADMINISTRADOR: son costo de compra (lectura conservadora de D-438).
 */

const D = (v: string) => new Prisma.Decimal(v);

function fullRow(seq: number) {
  const usd = seq % 2 === 0;
  const total = `${String(seq * 10)}.5000`;
  return {
    id: `p-${String(seq)}`,
    supplierId: 's-1',
    supplier: { name: `Proveedor ${String(seq)}`, code: 'PRV-1' },
    businessLine: { code: 'ROOFING' },
    type: 'COIL',
    docType: 'FACTURA',
    series: 'F001',
    number: String(seq),
    issueDate: new Date('2026-09-08T00:00:00Z'),
    currency: usd ? 'USD' : 'PEN',
    exchangeRate: D(usd ? '3.7500' : '1.0000'),
    exchangeRateSource: 'MANUAL',
    subtotal: D(total),
    igv: D('0'),
    total: D(total),
    totalPen: D(usd ? D(total).times('3.75').toFixed(4) : total),
    paymentTerms: 'CREDITO',
    creditDays: 30,
    dueDate: seq % 3 === 0 ? null : new Date('2026-10-08T00:00:00Z'),
    status: 'RECEIVED',
    serviceKind: null,
    relatedPurchaseId: null,
    relatedPurchase: null,
    relatedCuttingOrderId: null,
    relatedCuttingOrder: null,
    landedCostServices: [],
    sourceXmlKey: null,
    notes: null,
    // Las múltiplos de 3 están pagadas del todo: «Solo con saldo» las deja fuera.
    payments:
      seq % 3 === 0
        ? [
            {
              amount: D(total),
              currency: usd ? 'USD' : 'PEN',
              exchangeRate: D(usd ? '3.7500' : '1.0000'),
              reversedAt: null,
            },
          ]
        : [],
    receivedAt: null,
    createdAt: new Date('2026-09-08T00:00:00Z'),
  };
}
type Row = ReturnType<typeof fullRow>;

describe('PurchasesService.exportAll — el Excel es la lista entera (cc26 M2)', () => {
  let rows: Row[];
  let calls: number;
  let findMany: jest.Mock;
  let count: jest.Mock;
  let svc: PurchasesService;

  beforeEach(() => {
    calls = 0;
    rows = Array.from({ length: 14 }, (_, k) => fullRow(k + 1));
    findMany = jest.fn((args: { skip?: number; take?: number }): Promise<Row[]> => {
      calls += 1;
      const skip = args.skip ?? 0;
      return Promise.resolve(
        rows.slice(skip, args.take === undefined ? undefined : skip + args.take),
      );
    });
    count = jest.fn(() => {
      calls += 1;
      return Promise.resolve(rows.length);
    });
    svc = Object.create(PurchasesService.prototype) as PurchasesService;
    Object.assign(svc, { prisma: { purchase: { findMany, count } } });
  });

  async function allPages(raw: Record<string, string>) {
    const out: PurchaseListItemDto[] = [];
    let total = 0;
    for (let page = 1; ; page += 1) {
      const result = await svc.findAll(
        purchaseQuerySchema.parse({ ...raw, page: String(page), pageSize: '4' }),
      );
      total = result.total;
      out.push(...result.items);
      if (result.items.length === 0 || out.length >= total) break;
    }
    return { items: out, total };
  }

  it.each([
    ['sin filtros', {}],
    ['con orden por total', { sort: 'total', dir: 'asc' }],
    ['solo con saldo (filtro derivado)', { onlyWithBalance: 'true' }],
  ])('%s: las filas son las de todas las páginas, en el mismo orden', async (_, raw) => {
    const list = await allPages(raw);
    const exported = await svc.exportAll(purchaseExportQuerySchema.parse(raw));
    expect(exported.map((p) => p.id)).toEqual(list.items.map((p) => p.id));
    expect(exported).toHaveLength(list.total);
    expect(exported).toEqual(list.items);
  });

  it('solo con saldo: ninguna fila pagada del todo', async () => {
    const exported = await svc.exportAll(purchaseExportQuerySchema.parse({ onlyWithBalance: '1' }));
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.every((p) => Number(p.number) % 3 !== 0)).toBe(true);
  });

  it('pide a Prisma el mismo filtro y el mismo orden que la lista', async () => {
    const raw = { sort: 'supplier', dir: 'desc', status: 'RECEIVED', search: 'F001', type: 'COIL' };
    await svc.findAll(purchaseQuerySchema.parse(raw));
    const [listArgs] = findMany.mock.calls.at(-1) as [{ where: unknown; orderBy: unknown }];
    await svc.exportAll(purchaseExportQuerySchema.parse(raw));
    const [exportArgs] = findMany.mock.calls.at(-1) as [{ where: unknown; orderBy: unknown }];
    expect(exportArgs.where).toEqual(listArgs.where);
    expect(exportArgs.orderBy).toEqual(listArgs.orderBy);
  });

  it('la fila de total es la suma en soles de las filas exportadas', async () => {
    const exported = await svc.exportAll(purchaseExportQuerySchema.parse({}));
    const file = purchasesXlsx(exported, Role.ADMINISTRADOR, '2026-10-06');
    const book = XLSX.read(file.buffer, { type: 'buffer' });
    const grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets.Compras!, { header: 1 });
    const header = grid[0] as string[];
    const totalRow = grid.at(-1)!;
    expect(grid).toHaveLength(1 + exported.length + 1);
    expect(totalRow[0]).toBe(`Total (${String(exported.length)} compras)`);
    expect(totalRow[header.indexOf('Total (S/)')]).toBe(
      sum(exported.map((p) => p.totalPen)).toNumber(),
    );
    expect(totalRow[header.indexOf('Saldo (S/)')]).toBe(
      sum(exported.map((p) => balancePen(p))).toNumber(),
    );
    // En moneda de origen no se suma: dólares más soles no es un total.
    expect(totalRow[header.indexOf('Total')] ?? null).toBeNull();
    expect(totalRow[header.indexOf('Saldo')] ?? null).toBeNull();
    expect(file.filename).toBe('compras-2026-10-06.xlsx');
  });

  it.each([{}, { onlyWithBalance: 'true' }])(
    'las consultas no crecen con las filas (%o)',
    async (raw) => {
      async function callsFor(n: number) {
        rows = rows.slice(0, n);
        calls = 0;
        await svc.exportAll(purchaseExportQuerySchema.parse(raw));
        return calls;
      }
      const few = await callsFor(2);
      const many = await callsFor(12);
      expect(many).toBe(few);
      // Medido: 2 sin saldo (count, filas); 1 con saldo (el universo acotado).
      expect(many).toBe('onlyWithBalance' in raw ? 1 : 2);
    },
  );

  it(`más de ${String(LIST_XLSX_MAX_ROWS)} filas: 400 sin cargar ninguna`, async () => {
    count.mockResolvedValueOnce(LIST_XLSX_MAX_ROWS + 1);
    await expect(svc.exportAll(purchaseExportQuerySchema.parse({}))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it('solo con saldo: el tope se mide sobre las filas con saldo', async () => {
    const many = Array.from({ length: LIST_XLSX_MAX_ROWS + 1 }, () => fullRow(1));
    findMany.mockResolvedValueOnce(many);
    await expect(
      svc.exportAll(purchaseExportQuerySchema.parse({ onlyWithBalance: 'true' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('purchasesXlsx — columnas por rol', () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000001',
    supplierId: '00000000-0000-4000-8000-000000000002',
    supplierName: 'Proveedor',
    supplierCode: 'PRV-1',
    businessLine: 'roofing',
    type: 'COIL',
    docType: 'FACTURA',
    series: 'F001',
    number: '10',
    documentLabel: 'F001-10',
    issueDate: '2026-09-08',
    currency: 'USD',
    exchangeRate: '3.7500',
    exchangeRateSource: 'MANUAL',
    subtotal: '100.0000',
    igv: '18.0000',
    total: '118.0000',
    totalPen: '442.5000',
    paymentTerms: 'CREDITO',
    creditDays: 30,
    dueDate: null,
    status: 'RECEIVED',
    serviceKind: null,
    relatedPurchaseId: null,
    relatedPurchaseLabel: null,
    relatedCuttingOrderId: null,
    relatedCuttingOrderLabel: null,
    landedCostServices: [],
    sourceXmlKey: null,
    notes: null,
    paidAmount: '18.0000',
    balance: '100.0000',
    receivedAt: null,
    createdAt: '2026-09-08T00:00:00.000Z',
  } as PurchaseListItemDto;

  function grid(role: Role): unknown[][] {
    const book = XLSX.read(purchasesXlsx([row], role, '2026-10-06').buffer, { type: 'buffer' });
    return XLSX.utils.sheet_to_json<unknown[]>(book.Sheets.Compras!, { header: 1 });
  }

  it('el ADMINISTRADOR recibe los importes en su moneda y en soles', () => {
    const [header, line] = grid(Role.ADMINISTRADOR);
    expect(header).toEqual([
      'Comprobante',
      'Proveedor',
      'Línea',
      'Tipo',
      'Emisión',
      'Vence',
      'Moneda',
      'Total',
      'Saldo',
      'Total (S/)',
      'Saldo (S/)',
      'Estado',
    ]);
    expect(line?.slice(6, 11)).toEqual(['USD', 118, 100, 442.5, 375]);
  });

  it('el SUPERVISOR_PLANTA recibe las filas sin ningún importe (costo de compra)', () => {
    const sheet = grid(Role.SUPERVISOR_PLANTA);
    expect(sheet[0]).toEqual([
      'Comprobante',
      'Proveedor',
      'Línea',
      'Tipo',
      'Emisión',
      'Vence',
      'Estado',
    ]);
    expect(sheet[1]).toHaveLength(7);
    expect(sheet[1]?.some((c) => typeof c === 'number')).toBe(false);
    expect(sheet.at(-1)).toEqual(['Total (1 compra)']);
  });
});
