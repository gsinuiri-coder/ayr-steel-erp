import * as XLSX from 'xlsx';
import { BadRequestException } from '@nestjs/common';
import {
  DocType,
  FiscalDocType,
  FiscalDocumentOrigin,
  FiscalDocumentStatus,
  PaymentTerms,
  Prisma,
} from '@prisma/client';
import {
  fiscalDocumentExportQuerySchema,
  fiscalDocumentQuerySchema,
  LIST_XLSX_MAX_ROWS,
  Role,
  sum,
  type FiscalDocumentListItemDto,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { fiscalDocumentsXlsx } from './fiscal-documents-xlsx';
import { InvoicingService } from './invoicing.service';

/**
 * cc26 (D-provisional): el Excel de la lista de comprobantes trae las mismas filas que la
 * pantalla —todas las páginas, en el mismo orden, con el mismo alcance del vendedor— y su fila
 * de total es la suma de esas filas.
 *
 * La base es un doble en memoria que respeta `skip`/`take` y el alcance del vendedor de
 * `fiscalDocumentListWhere` (creó el comprobante, o es de su pedido): con eso, «el Excel es la
 * concatenación de las páginas» es una afirmación sobre el servicio y no sobre el doble.
 */

const dec = (v: string) => new Prisma.Decimal(v);
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const SELLER_A = uuid(901);
const SELLER_B = uuid(902);

function documentRow(i: number, sellerId: string, totalPen: string) {
  return {
    id: uuid(i),
    docType: FiscalDocType.FACTURA,
    status: FiscalDocumentStatus.ACCEPTED,
    origin: FiscalDocumentOrigin.ISSUED_HERE,
    number: `F001-${String(i).padStart(8, '0')}`,
    seriesId: null,
    seriesRef: null,
    correlative: i,
    customerId: uuid(9000),
    customer: {
      id: uuid(9000),
      name: `Cliente ${String(i)}`,
      docType: DocType.RUC,
      docNumber: '20123456789',
      address: null,
      email: null,
      isSystem: false,
    },
    salesOrderId: uuid(5000 + i),
    salesOrder: { id: uuid(5000 + i), seq: i, sellerId },
    dispatchId: null,
    dispatch: null,
    affectedDocumentId: null,
    affectedDocument: null,
    creditNoteReason: null,
    replacesDocumentId: null,
    replacesDocument: null,
    replacedBy: null,
    supersedesDocumentId: null,
    supersededBy: null,
    archivedAt: null,
    issueDate: new Date('2026-09-20T00:00:00.000Z'),
    paymentTerms: PaymentTerms.CONTADO,
    dueDate: null,
    subtotalPen: dec(totalPen),
    igvPen: dec('0'),
    totalPen: dec(totalPen),
    detractionCode: null,
    detractionPct: null,
    detractionAmountPen: null,
    genericCustomerOverrideById: null,
    notes: null,
    sunatHash: null,
    rejectionCode: null,
    rejectionMessage: null,
    pdfKey: null,
    xmlKey: null,
    cdrKey: null,
    sendAttempts: 0,
    lastSendError: null,
    lastAttemptAt: null,
    createdById: uuid(800),
    createdAt: new Date('2026-09-20T10:00:00.000Z'),
    issuedAt: null,
    acceptedAt: null,
    voidedAt: null,
    voidedById: null,
    annulledAt: null,
    annulledById: null,
    annulReason: null,
    items: [],
    payments: [],
    creditNotes: [],
  };
}
type Row = ReturnType<typeof documentRow>;

/** El alcance del vendedor de `fiscalDocumentListWhere`, leído del `where` que recibe Prisma. */
function inScope(row: Row, where: Prisma.FiscalDocumentWhereInput): boolean {
  const and = (where.AND ?? []) as Prisma.FiscalDocumentWhereInput[];
  const scope = and.find((c) => c.OR?.some((o) => 'createdById' in o));
  if (!scope) return true;
  const sellerId = (scope.OR?.[0] as { createdById: string }).createdById;
  return row.createdById === sellerId || row.salesOrder.sellerId === sellerId;
}

const admin = { id: uuid(800), role: Role.ADMINISTRADOR } as RequestUser;
const sellerA = { id: SELLER_A, role: Role.VENDEDOR } as RequestUser;

describe('InvoicingService.exportAll — el Excel es la lista entera (cc26)', () => {
  let rows: Row[];
  let calls: number;
  let count: jest.Mock;
  let findMany: jest.Mock;
  let service: InvoicingService;

  beforeEach(() => {
    calls = 0;
    // Importes que en `number` no suman exacto (0,1 + 0,2), y dos vendedores alternados. Las
    // filas 3, 6, 9… valen 0: sin saldo, quedan fuera de `pendingOnly`.
    rows = Array.from({ length: 23 }, (_, k) =>
      documentRow(
        k + 1,
        k % 2 === 0 ? SELLER_A : SELLER_B,
        (k + 1) % 3 === 0 ? '0.0000' : `${String(k)}.${k % 2 === 0 ? '1000' : '2000'}`,
      ),
    );
    const counted =
      <A, T>(fn: (args: A) => T) =>
      (args: A) => {
        calls += 1;
        return Promise.resolve(fn(args));
      };
    count = jest.fn(
      counted(
        ({ where }: { where: Prisma.FiscalDocumentWhereInput }) =>
          rows.filter((r) => inScope(r, where)).length,
      ),
    );
    findMany = jest.fn(
      counted(
        ({
          where,
          skip = 0,
          take,
        }: {
          where: Prisma.FiscalDocumentWhereInput;
          skip?: number;
          take?: number;
        }) =>
          rows
            .filter((r) => inScope(r, where))
            .slice(skip, take === undefined ? undefined : skip + take),
      ),
    );
    const prisma = {
      fiscalDocument: { count, findMany },
      invoicingSetting: {
        findFirst: jest.fn(
          counted(() => ({
            id: 'settings-1',
            providerOffline: false,
            manualByDefault: false,
            alertAfterHours: 24,
            updatedAt: new Date(),
          })),
        ),
      },
      user: { findMany: jest.fn(counted(() => [])) },
      dispatch: { findMany: jest.fn(counted(() => [])) },
    };
    service = new InvoicingService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  async function allPages(raw: Record<string, string>, actor: RequestUser) {
    const out: FiscalDocumentListItemDto[] = [];
    let total = 0;
    for (let page = 1; ; page += 1) {
      const result = await service.findAll(
        fiscalDocumentQuerySchema.parse({ ...raw, page: String(page), pageSize: '5' }),
        actor,
      );
      total = result.total;
      out.push(...result.items);
      if (result.items.length === 0 || out.length >= total) break;
    }
    return { items: out, total };
  }

  it.each([
    ['sin filtros', {}],
    ['con orden por total', { sort: 'total', dir: 'desc' }],
    ['solo con saldo (filtro derivado)', { pendingOnly: 'true' }],
  ])('%s: las filas son las de todas las páginas, en el mismo orden', async (_, raw) => {
    const list = await allPages(raw, admin);
    const exported = await service.exportAll(fiscalDocumentExportQuerySchema.parse(raw), admin);
    expect(exported.map((d) => d.id)).toEqual(list.items.map((d) => d.id));
    expect(exported).toHaveLength(list.total);
    expect(exported).toEqual(list.items);
  });

  it('pide a Prisma el mismo filtro y el mismo orden que la lista', async () => {
    const raw = { sort: 'customer', dir: 'asc', search: 'Cliente', docType: 'FACTURA' };
    await service.findAll(fiscalDocumentQuerySchema.parse(raw), sellerA);
    const [listArgs] = findMany.mock.calls.at(-1) as [{ where: unknown; orderBy: unknown }];
    await service.exportAll(fiscalDocumentExportQuerySchema.parse(raw), sellerA);
    const [exportArgs] = findMany.mock.calls.at(-1) as [{ where: unknown; orderBy: unknown }];
    expect(exportArgs.where).toEqual(listArgs.where);
    expect(exportArgs.orderBy).toEqual(listArgs.orderBy);
  });

  it('un VENDEDOR no recibe comprobantes de otro vendedor', async () => {
    const exported = await service.exportAll(fiscalDocumentExportQuerySchema.parse({}), sellerA);
    const mine = rows.filter((r) => r.salesOrder.sellerId === SELLER_A).map((r) => r.id);
    expect(exported.map((d) => d.id)).toEqual(mine);
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.length).toBeLessThan(rows.length);
  });

  it('la fila de total es la suma de las filas exportadas', async () => {
    const exported = await service.exportAll(fiscalDocumentExportQuerySchema.parse({}), admin);
    const file = fiscalDocumentsXlsx(exported, Role.ADMINISTRADOR, '2026-10-06');
    const book = XLSX.read(file.buffer, { type: 'buffer' });
    const grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets.Comprobantes!, { header: 1 });
    const header = grid[0] as string[];
    const totalRow = grid.at(-1)!;
    expect(grid).toHaveLength(1 + exported.length + 1);
    expect(totalRow[0]).toBe(`Total (${String(exported.length)} comprobantes)`);
    expect(totalRow[header.indexOf('Total (S/)')]).toBe(
      sum(exported.map((d) => d.totalPen)).toNumber(),
    );
    expect(totalRow[header.indexOf('Saldo (S/)')]).toBe(
      sum(exported.map((d) => d.balancePen)).toNumber(),
    );
    expect(file.filename).toBe('comprobantes-2026-10-06.xlsx');
  });

  it('las consultas no crecen con las filas', async () => {
    async function callsFor(n: number) {
      rows = rows.slice(0, n);
      calls = 0;
      await service.exportAll(fiscalDocumentExportQuerySchema.parse({}), admin);
      return calls;
    }
    const few = await callsFor(2);
    const many = await callsFor(20);
    expect(many).toBe(few);
    // Medido: 5 (count, filas, ajustes, usuarios, despachos), las mismas de una página.
    expect(many).toBe(5);
  });

  it(`más de ${String(LIST_XLSX_MAX_ROWS)} filas: 400 sin cargar ninguna`, async () => {
    count.mockResolvedValueOnce(LIST_XLSX_MAX_ROWS + 1);
    await expect(
      service.exportAll(fiscalDocumentExportQuerySchema.parse({}), admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it(`exactamente ${String(LIST_XLSX_MAX_ROWS)} filas todavía se exportan`, async () => {
    count.mockResolvedValueOnce(LIST_XLSX_MAX_ROWS);
    await service.exportAll(fiscalDocumentExportQuerySchema.parse({}), admin);
    const [args] = findMany.mock.calls[0] as [{ skip: number; take: number }];
    expect(args).toMatchObject({ skip: 0, take: LIST_XLSX_MAX_ROWS });
  });

  it('el mensaje del tope dice cuántas filas y cuál es el tope', async () => {
    count.mockResolvedValueOnce(LIST_XLSX_MAX_ROWS + 7);
    await expect(
      service.exportAll(fiscalDocumentExportQuerySchema.parse({}), admin),
    ).rejects.toThrow(
      `La exportación tiene ${String(LIST_XLSX_MAX_ROWS + 7)} filas y el tope es ${String(LIST_XLSX_MAX_ROWS)}: acota los filtros.`,
    );
  });

  it('la query de exportación descarta page y pageSize', () => {
    const parsed = fiscalDocumentExportQuerySchema.parse({
      page: '3',
      pageSize: '10',
      search: 'x',
    });
    expect(parsed).not.toHaveProperty('page');
    expect(parsed).not.toHaveProperty('pageSize');
    expect(parsed.search).toBe('x');
  });
});

describe('fiscalDocumentsXlsx — columnas', () => {
  it('los dos roles reciben las mismas columnas: la lista no trae costos ni márgenes', () => {
    const headers = (role: Role) => {
      const book = XLSX.read(fiscalDocumentsXlsx([], role, '2026-10-06').buffer, {
        type: 'buffer',
      });
      return XLSX.utils.sheet_to_json<unknown[]>(book.Sheets.Comprobantes!, { header: 1 })[0];
    };
    expect(headers(Role.VENDEDOR)).toEqual(headers(Role.ADMINISTRADOR));
    expect((headers(Role.VENDEDOR) as string[]).join('|')).not.toMatch(/costo|margen|piso/i);
  });
});
