import * as XLSX from 'xlsx';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  LIST_XLSX_MAX_ROWS,
  Role,
  salesOrderExportQuerySchema,
  salesOrderQuerySchema,
  sum,
  type SalesOrderListItemDto,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { salesOrdersXlsx } from './sales-orders-xlsx';
import { SalesOrdersService } from './sales-orders.service';

/**
 * cc26 M2 (D-provisional): el Excel de la lista de pedidos trae las mismas filas que la pantalla
 * —todas las páginas, en el mismo orden, con el mismo alcance del vendedor— y su fila de total
 * es la suma de esas filas. El doble en memoria respeta `skip`/`take` y el `sellerId` de
 * `sellerWhere`.
 */

const D = (v: string) => new Prisma.Decimal(v);
const SELLER_A = '00000000-0000-4000-8000-00000000000a';
const SELLER_B = '00000000-0000-4000-8000-00000000000b';

function fullRow(seq: number, sellerId: string, totalPen: string) {
  return {
    id: `o-${String(seq)}`,
    seq,
    quotation: seq % 3 === 0 ? null : { id: `q-${String(seq)}`, seq },
    customer: { id: 'c-1', name: `Cliente ${String(seq)}`, docNumber: '20123456789' },
    status: 'CONFIRMED',
    origin: 'CREATED_HERE',
    issueDate: new Date('2026-09-08T00:00:00Z'),
    subtotalPen: D(totalPen),
    igvPen: D('0'),
    totalPen: D(totalPen),
    notes: null,
    createdAt: new Date('2026-09-08T00:00:00Z'),
    createdById: sellerId,
    sellerId,
    cancelledAt: null,
    promisedDeliveryDate: null,
    _count: { items: 1, reservations: seq % 2 },
  };
}
type Row = ReturnType<typeof fullRow>;

const admin = { id: 'u-admin', role: Role.ADMINISTRADOR } as RequestUser;
const sellerA = { id: SELLER_A, role: Role.VENDEDOR } as RequestUser;

describe('SalesOrdersService.exportAll — el Excel es la lista entera (cc26 M2)', () => {
  let rows: Row[];
  let calls: number;
  let findMany: jest.Mock;
  let count: jest.Mock;
  let svc: SalesOrdersService;

  beforeEach(() => {
    calls = 0;
    rows = Array.from({ length: 13 }, (_, k) =>
      fullRow(k + 1, k % 2 === 0 ? SELLER_A : SELLER_B, `${String(k)}.${k % 2 ? '3333' : '0101'}`),
    );
    const scoped = (where: { sellerId?: string } | undefined) =>
      rows.filter((r) => where?.sellerId === undefined || r.sellerId === where.sellerId);
    findMany = jest.fn(
      (args: { where?: { sellerId?: string }; skip?: number; take?: number }): Promise<Row[]> => {
        calls += 1;
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
    const counted = <T>(value: T) =>
      jest.fn(() => {
        calls += 1;
        return Promise.resolve(value);
      });
    svc = Object.create(SalesOrdersService.prototype) as SalesOrdersService;
    Object.assign(svc, {
      prisma: {
        salesOrder: { findMany, count },
        user: { findMany: counted([]) },
        fiscalDocument: {
          findMany: jest.fn((args: { where: { salesOrderId: { in: string[] } } }) => {
            calls += 1;
            return Promise.resolve(
              args.where.salesOrderId.in
                .filter((id) => id.endsWith('2'))
                .map((id) => ({
                  id: '00000000-0000-4000-8000-000000000001',
                  number: `F001-${id}`,
                  docType: 'FACTURA',
                  issueDate: new Date('2026-09-09T00:00:00Z'),
                  salesOrderId: id,
                })),
            );
          }),
        },
        productionOrder: { findMany: counted([]) },
      },
    });
  });

  async function allPages(raw: Record<string, string>, actor: RequestUser) {
    const out: SalesOrderListItemDto[] = [];
    let total = 0;
    for (let page = 1; ; page += 1) {
      const result = await svc.findAll(
        actor,
        salesOrderQuerySchema.parse({ ...raw, page: String(page), pageSize: '4' }),
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
    ['con etapas e historia', { stage: 'FULFILLED,CANCELLED' }],
  ])('%s: las filas son las de todas las páginas, en el mismo orden', async (_, raw) => {
    const list = await allPages(raw, admin);
    const exported = await svc.exportAll(admin, salesOrderExportQuerySchema.parse(raw));
    expect(exported.map((o) => o.id)).toEqual(list.items.map((o) => o.id));
    expect(exported).toHaveLength(list.total);
    expect(exported).toEqual(list.items);
  });

  it('pide a Prisma el mismo filtro y el mismo orden que la lista', async () => {
    const raw = { sort: 'customer', dir: 'desc', stage: 'CONFIRMED,READY', search: 'PED-7' };
    await svc.findAll(sellerA, salesOrderQuerySchema.parse(raw));
    const [listArgs] = findMany.mock.calls.at(-1) as [{ where: unknown; orderBy: unknown }];
    await svc.exportAll(sellerA, salesOrderExportQuerySchema.parse(raw));
    const [exportArgs] = findMany.mock.calls.at(-1) as [{ where: unknown; orderBy: unknown }];
    expect(exportArgs.where).toEqual(listArgs.where);
    expect(exportArgs.orderBy).toEqual(listArgs.orderBy);
  });

  it('un VENDEDOR no recibe pedidos de otro vendedor', async () => {
    const exported = await svc.exportAll(sellerA, salesOrderExportQuerySchema.parse({}));
    const mine = rows.filter((r) => r.sellerId === SELLER_A).map((r) => r.id);
    expect(exported.map((o) => o.id)).toEqual(mine);
    expect(exported.every((o) => o.sellerId === SELLER_A)).toBe(true);
  });

  it('la fila de total es la suma de las filas exportadas', async () => {
    const exported = await svc.exportAll(admin, salesOrderExportQuerySchema.parse({}));
    const file = salesOrdersXlsx(exported, Role.ADMINISTRADOR, '2026-10-06');
    const book = XLSX.read(file.buffer, { type: 'buffer' });
    const grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets.Pedidos!, { header: 1 });
    const header = grid[0] as string[];
    const totalRow = grid.at(-1)!;
    expect(grid).toHaveLength(1 + exported.length + 1);
    expect(totalRow[0]).toBe(`Total (${String(exported.length)} pedidos)`);
    expect(totalRow[header.indexOf('Total (S/)')]).toBe(
      sum(exported.map((o) => o.totalPen)).toNumber(),
    );
    expect(file.filename).toBe('pedidos-2026-10-06.xlsx');
  });

  it('las consultas no crecen con las filas', async () => {
    async function callsFor(n: number) {
      rows = rows.slice(0, n);
      calls = 0;
      await svc.exportAll(admin, salesOrderExportQuerySchema.parse({}));
      return calls;
    }
    const few = await callsFor(2);
    const many = await callsFor(12);
    expect(many).toBe(few);
    // Medido: 5 (count, filas, usuarios, comprobantes, órdenes de producción).
    expect(many).toBe(5);
  });

  it(`más de ${String(LIST_XLSX_MAX_ROWS)} filas: 400 sin cargar ninguna`, async () => {
    count.mockResolvedValueOnce(LIST_XLSX_MAX_ROWS + 1);
    await expect(
      svc.exportAll(admin, salesOrderExportQuerySchema.parse({})),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('salesOrdersXlsx — columnas y celdas', () => {
  const base = {
    id: '00000000-0000-4000-8000-000000000001',
    code: 'PED-000001',
    quotationId: null,
    quotationCode: null,
    customerId: '00000000-0000-4000-8000-000000000002',
    customerName: 'Cliente',
    customerDocNumber: '20123456789',
    status: 'CONFIRMED',
    origin: 'CREATED_HERE',
    issueDate: '2026-09-08',
    subtotalPen: '100.0000',
    igvPen: '18.0000',
    totalPen: '118.0000',
    notes: null,
    createdAt: '2026-09-08T00:00:00.000Z',
    createdById: '00000000-0000-4000-8000-000000000003',
    createdByName: null,
    sellerId: '00000000-0000-4000-8000-000000000003',
    sellerName: null,
    cancelledAt: null,
    promisedDeliveryDate: null,
    readiness: {
      status: 'SIN_PRODUCCION',
      orderedMl: '0.000',
      reportedMl: '0.000',
      missingMl: '0.000',
    },
    stage: 'READY',
    documents: [],
    itemCount: 1,
    activeReservations: 2,
  } as SalesOrderListItemDto;

  function grid(rows: SalesOrderListItemDto[], role: Role): unknown[][] {
    const book = XLSX.read(salesOrdersXlsx(rows, role, '2026-10-06').buffer, { type: 'buffer' });
    return XLSX.utils.sheet_to_json<unknown[]>(book.Sheets.Pedidos!, { header: 1 });
  }

  it('los dos roles reciben las mismas columnas: la lista no trae costos ni márgenes', () => {
    expect(grid([], Role.VENDEDOR)[0]).toEqual(grid([], Role.ADMINISTRADOR)[0]);
    expect((grid([], Role.VENDEDOR)[0] as string[]).join('|')).not.toMatch(/costo|margen|piso/i);
  });

  it('la fila dice lo que dice la pantalla: directo, comprobantes con su NC y estado', () => {
    const [, direct, withDocs] = grid(
      [
        base,
        {
          ...base,
          quotationId: base.id,
          quotationCode: 'COT-000009',
          stage: 'CONFIRMED',
          documents: [
            { id: base.id, number: 'F001-00000010', docType: 'FACTURA', issueDate: '2026-09-09' },
            { id: base.id, number: null, docType: 'NOTA_CREDITO', issueDate: '2026-09-10' },
          ],
        },
      ],
      Role.VENDEDOR,
    );
    expect(direct).toEqual([
      'PED-000001',
      'Cliente',
      '20123456789',
      'Directo',
      '',
      '2026-09-08',
      118,
      2,
      'Listo',
    ]);
    expect(withDocs?.[3]).toBe('COT-000009');
    expect(withDocs?.[4]).toBe('F001-00000010, Sin número (NC)');
    expect(withDocs?.[8]).toBe('Confirmado');
  });
});
