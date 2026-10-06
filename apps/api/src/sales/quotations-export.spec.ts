import * as XLSX from 'xlsx';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  LIST_XLSX_MAX_ROWS,
  quotationExportQuerySchema,
  quotationQuerySchema,
  Role,
  sum,
  type QuotationListItemDto,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { quotationsXlsx } from './quotations-xlsx';
import { QuotationsService } from './quotations.service';

/**
 * cc26 (D-provisional): el Excel de la lista de cotizaciones trae las mismas filas que la
 * pantalla —todas las páginas, en el mismo orden, con el mismo alcance del vendedor— y su fila
 * de total es la suma de esas filas. El doble en memoria respeta `skip`/`take`, el `sellerId`
 * de `quotationSellerWhere` y el camino de `sort=invoice` (claves, luego la página por id).
 */

const D = (v: string) => new Prisma.Decimal(v);
const SELLER_A = 'u-a';
const SELLER_B = 'u-b';

function fullRow(seq: number, sellerId: string, totalPen: string, notes: string | null = null) {
  const id = `q-${String(seq)}`;
  return {
    id,
    seq,
    notes,
    status: 'EMITTED',
    issueDate: new Date('2026-09-08T00:00:00Z'),
    validUntil: null,
    subtotalPen: D(totalPen),
    igvPen: D('0'),
    totalPen: D(totalPen),
    pdfKey: null,
    customer: { id: 'c-1', name: `Cliente ${String(seq)}`, docNumber: '20123456789' },
    salesOrders: [] as { id: string; seq: number; fiscalDocuments: unknown[] }[],
    items: [],
    createdById: sellerId,
    sellerId,
    createdAt: new Date('2026-09-08T00:00:00Z'),
    emittedAt: null,
    confirmedAt: null,
    cancelledAt: null,
    _count: { items: 1 },
  };
}
type Row = ReturnType<typeof fullRow>;

const admin = { id: 'u-admin', role: Role.ADMINISTRADOR } as RequestUser;
const sellerA = { id: SELLER_A, role: Role.VENDEDOR } as RequestUser;

describe('QuotationsService.exportAll — el Excel es la lista entera (cc26)', () => {
  let rows: Row[];
  let calls: number;
  let findMany: jest.Mock;
  let count: jest.Mock;
  let svc: QuotationsService;

  beforeEach(() => {
    calls = 0;
    rows = Array.from({ length: 17 }, (_, k) =>
      fullRow(
        k + 1,
        k % 2 === 0 ? SELLER_A : SELLER_B,
        `${String(k)}.${k % 2 === 0 ? '1000' : '2000'}`,
        // Algunas importadas, para que `sort=invoice` tenga números que ordenar.
        k % 4 === 0 ? `Factura externa: FFA1-${String(100 - k)}` : null,
      ),
    );
    const scoped = (where: { sellerId?: string } | undefined) =>
      rows.filter((r) => where?.sellerId === undefined || r.sellerId === where.sellerId);
    findMany = jest.fn(
      (args: {
        where?: { sellerId?: string; id?: { in: string[] } };
        select?: unknown;
        skip?: number;
        take?: number;
      }): Promise<unknown[]> => {
        calls += 1;
        if (args.select)
          return Promise.resolve(
            scoped(args.where).map(({ id, seq, notes, salesOrders }) => ({
              id,
              seq,
              notes,
              salesOrders,
            })),
          );
        const ids = args.where?.id?.in;
        if (ids) return Promise.resolve(rows.filter((r) => ids.includes(r.id)));
        const skip = args.skip ?? 0;
        return Promise.resolve(
          scoped(args.where).slice(skip, args.take === undefined ? undefined : skip + args.take),
        );
      },
    );
    count = jest.fn((args: { where?: { sellerId?: string } }) => {
      calls += 1;
      return Promise.resolve(scoped(args.where).length);
    });
    svc = Object.create(QuotationsService.prototype) as QuotationsService;
    Object.assign(svc, {
      prisma: {
        quotation: { findMany, count },
        fiscalDocument: { findMany: jest.fn().mockResolvedValue([]) },
        user: {
          findMany: jest.fn(() => {
            calls += 1;
            return Promise.resolve([]);
          }),
        },
      },
    });
  });

  async function allPages(raw: Record<string, string>, actor: RequestUser) {
    const out: QuotationListItemDto[] = [];
    let total = 0;
    for (let page = 1; ; page += 1) {
      const result = await svc.findAll(
        actor,
        quotationQuerySchema.parse({ ...raw, page: String(page), pageSize: '4' }),
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
    ['ordenada por comprobante (D-387)', { sort: 'invoice', dir: 'desc' }],
  ])('%s: las filas son las de todas las páginas, en el mismo orden', async (_, raw) => {
    const list = await allPages(raw, admin);
    const exported = await svc.exportAll(admin, quotationExportQuerySchema.parse(raw));
    expect(exported.map((q) => q.id)).toEqual(list.items.map((q) => q.id));
    expect(exported).toHaveLength(list.total);
    expect(exported).toEqual(list.items);
  });

  it('pide a Prisma el mismo filtro y el mismo orden que la lista', async () => {
    const raw = { sort: 'customer', dir: 'desc', status: 'EMITTED,CONFIRMED' };
    await svc.findAll(sellerA, quotationQuerySchema.parse(raw));
    const [listArgs] = findMany.mock.calls.at(-1) as [{ where: unknown; orderBy: unknown }];
    await svc.exportAll(sellerA, quotationExportQuerySchema.parse(raw));
    const [exportArgs] = findMany.mock.calls.at(-1) as [{ where: unknown; orderBy: unknown }];
    expect(exportArgs.where).toEqual(listArgs.where);
    expect(exportArgs.orderBy).toEqual(listArgs.orderBy);
  });

  it.each([{}, { sort: 'invoice' }])(
    'un VENDEDOR no recibe cotizaciones de otro vendedor (%o)',
    async (raw) => {
      const exported = await svc.exportAll(sellerA, quotationExportQuerySchema.parse(raw));
      const mine = rows.filter((r) => r.sellerId === SELLER_A).map((r) => r.id);
      expect([...exported.map((q) => q.id)].sort()).toEqual([...mine].sort());
      expect(exported.every((q) => q.sellerId === SELLER_A)).toBe(true);
    },
  );

  it('la fila de total es la suma de las filas exportadas', async () => {
    const exported = await svc.exportAll(admin, quotationExportQuerySchema.parse({}));
    const file = quotationsXlsx(exported, Role.ADMINISTRADOR, '2026-10-06');
    const book = XLSX.read(file.buffer, { type: 'buffer' });
    const grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets.Cotizaciones!, { header: 1 });
    const header = grid[0] as string[];
    const totalRow = grid.at(-1)!;
    expect(grid).toHaveLength(1 + exported.length + 1);
    expect(totalRow[0]).toBe(`Total (${String(exported.length)} cotizaciones)`);
    expect(totalRow[header.indexOf('Total (S/)')]).toBe(
      sum(exported.map((q) => q.totalPen)).toNumber(),
    );
    expect(file.filename).toBe('cotizaciones-2026-10-06.xlsx');
  });

  it.each([{}, { sort: 'invoice' }])('las consultas no crecen con las filas (%o)', async (raw) => {
    async function callsFor(n: number) {
      rows = rows.slice(0, n);
      calls = 0;
      await svc.exportAll(admin, quotationExportQuerySchema.parse(raw));
      return calls;
    }
    const few = await callsFor(2);
    const many = await callsFor(15);
    expect(many).toBe(few);
    // Medido: 3 (count o claves, filas, usuarios).
    expect(many).toBe(3);
  });

  it(`más de ${String(LIST_XLSX_MAX_ROWS)} filas: 400 sin cargar ninguna`, async () => {
    count.mockResolvedValueOnce(LIST_XLSX_MAX_ROWS + 1);
    await expect(svc.exportAll(admin, quotationExportQuerySchema.parse({}))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it(`con sort=invoice, el tope se mide sobre las claves, antes de cargar la página`, async () => {
    rows = Array.from({ length: LIST_XLSX_MAX_ROWS + 1 }, (_, k) => fullRow(k + 1, SELLER_A, '1'));
    await expect(
      svc.exportAll(admin, quotationExportQuerySchema.parse({ sort: 'invoice' })),
    ).rejects.toThrow(
      `La exportación tiene ${String(LIST_XLSX_MAX_ROWS + 1)} filas y el tope es ${String(LIST_XLSX_MAX_ROWS)}: acota los filtros.`,
    );
    // Solo la consulta de claves.
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

describe('quotationsXlsx — columnas y celdas', () => {
  const base: QuotationListItemDto = {
    id: '00000000-0000-4000-8000-000000000001',
    code: 'COT-000001',
    customerId: '00000000-0000-4000-8000-000000000002',
    customerName: 'Cliente',
    customerDocNumber: '20123456789',
    status: 'EMITTED',
    issueDate: '2026-09-08',
    validUntil: null,
    isExpired: false,
    subtotalPen: '100.0000',
    igvPen: '18.0000',
    totalPen: '118.0000',
    notes: null,
    externalInvoice: null,
    invoiceDocuments: [],
    salesOrderId: null,
    salesOrderCode: null,
    pdfKey: null,
    createdAt: '2026-09-08T00:00:00.000Z',
    createdByName: null,
    sellerId: '00000000-0000-4000-8000-000000000003',
    sellerName: null,
    emittedAt: null,
    confirmedAt: null,
    cancelledAt: null,
    itemCount: 1,
  };

  function grid(rows: QuotationListItemDto[], role: Role): unknown[][] {
    const book = XLSX.read(quotationsXlsx(rows, role, '2026-10-06').buffer, { type: 'buffer' });
    return XLSX.utils.sheet_to_json<unknown[]>(book.Sheets.Cotizaciones!, { header: 1 });
  }

  it('los dos roles reciben las mismas columnas: la lista no trae costos ni márgenes', () => {
    expect(grid([], Role.VENDEDOR)[0]).toEqual(grid([], Role.ADMINISTRADOR)[0]);
    expect((grid([], Role.VENDEDOR)[0] as string[]).join('|')).not.toMatch(/costo|margen|piso/i);
  });

  it('la fila dice lo que dice la pantalla: comprobante, vigencia, vencida y pedido', () => {
    const [, reference, mismatch, expired] = grid(
      [
        { ...base, externalInvoice: 'FFA1-1000' },
        {
          ...base,
          externalInvoice: 'BBV1-347',
          invoiceDocuments: [{ id: base.id, number: 'BBV1-00000348' }],
          validUntil: '2026-09-30',
          salesOrderId: base.id,
          salesOrderCode: 'PED-000009',
        },
        { ...base, isExpired: true },
      ],
      Role.VENDEDOR,
    );
    expect(reference).toEqual([
      'COT-000001',
      'FFA1-1000 (solo referencia)',
      'Cliente',
      '20123456789',
      '2026-09-08',
      'Sin vencimiento',
      118,
      'Emitida',
      '',
    ]);
    expect(mismatch?.[1]).toBe('BBV1-00000348 (Excel: BBV1-347)');
    expect(mismatch?.[5]).toBe('2026-09-30');
    expect(mismatch?.[8]).toBe('PED-000009');
    expect(expired?.[7]).toBe('Vencida');
  });
});
