import { Prisma } from '@prisma/client';
import {
  compareImportedInvoiceNumbers,
  importedInvoiceNumber,
  invoiceNumberContains,
  normalizeInvoiceNumber,
  quotationInvoiceState,
  quotationQuerySchema,
  Role,
  shownInvoiceNumber,
} from '@ayr/shared';
import { orderByInvoiceNumber, quotationOrderBy } from '../common/list-orderings';
import { QuotationsService } from './quotations.service';

/**
 * D-387 — la columna «Comprobante» de la lista de cotizaciones.
 *
 * Dos fuentes, calculadas al leer: el número de la marca del importador (`Factura externa: …`,
 * primera línea de las observaciones, D-152; `importedInvoiceNumber`) y los comprobantes
 * vigentes del pedido de la cotización. De las dos sale el estado (`quotationInvoiceState`):
 * solo referencia, registrado, no coincide o nada.
 */

describe('importedInvoiceNumber — la lectura de la marca', () => {
  it.each([
    ['Factura externa: FFA1-1419', 'FFA1-1419'],
    ['Factura externa: BBV1-347', 'BBV1-347'],
    ['Factura externa: FFA1-00001419', 'FFA1-00001419'],
    ['Factura externa: ffa1-1419', 'ffa1-1419'],
    ['Factura externa: FFA1-1350\nEntregar en obra', 'FFA1-1350'],
    ['Factura externa:  FFA1-1419  ', 'FFA1-1419'],
    // cc28 (P2-2 de cc19, D-462): los espacios alrededor del guion no cambian el número.
    ['Factura externa: FFA1 - 1419', 'FFA1-1419'],
    ['Factura externa: BBV1 -347', 'BBV1-347'],
  ])('calza: %j → %s', (notes, expected) => {
    expect(importedInvoiceNumber(notes)).toBe(expected);
  });

  it.each([
    ['sin observaciones', null],
    ['una cotización no importada', 'Entregar en obra'],
    ['un número en una cotización no importada', 'Ver FFA1-1419'],
    ['la marca tipeada más abajo', 'Nota\nFactura externa: FFA1-1419'],
    ['la marca sin número', 'Factura externa: '],
    ['un número sin serie', 'Factura externa: 1419'],
    ['una serie de tres', 'Factura externa: FA1-1419'],
    ['una serie que empieza con dígito', 'Factura externa: 0FA1-1419'],
    ['un correlativo de nueve dígitos', 'Factura externa: FFA1-123456789'],
    ['texto pegado al número', 'Factura externa: FFA1-1419 anulada'],
  ])('no calza: %s', (_label, notes) => {
    expect(importedInvoiceNumber(notes)).toBeNull();
  });

  it('con varios números en el texto, solo cuenta el de la marca', () => {
    expect(importedInvoiceNumber('Factura externa: FFA1-1419\nReemplaza a FFA1-1400')).toBe(
      'FFA1-1419',
    );
    // Dos números en la marca no son un comprobante: no se elige uno.
    expect(importedInvoiceNumber('Factura externa: FFA1-1419 FFA1-1420')).toBeNull();
    expect(importedInvoiceNumber('Factura externa: FFA1-1419/FFA1-1420')).toBeNull();
  });
});

describe('normalizeInvoiceNumber y compareImportedInvoiceNumbers — la comparación normalizada', () => {
  it.each([
    ['FFA1-00001419', 'FFA1-1419'],
    ['ffa1-1419', 'FFA1-1419'],
    [' BBV1-0347 ', 'BBV1-347'],
    ['F001-00000000', 'F001-0'],
    ['FFA1 - 1419', 'FFA1-1419'],
  ])('%s → %s', (value, expected) => {
    expect(normalizeInvoiceNumber(value)).toBe(expected);
  });

  it.each([['1419'], ['FFA1-1419 FFA1-1420'], ['']])('%j no se normaliza', (v) => {
    expect(normalizeInvoiceNumber(v)).toBeNull();
  });

  it('ordena por serie y después por correlativo numérico', () => {
    const sorted = ['FFA1-1000', 'BBV1-347', 'FFA1-999', 'ffa1-1001', 'BBV1-0341'].sort(
      compareImportedInvoiceNumbers,
    );
    expect(sorted).toEqual(['BBV1-0341', 'BBV1-347', 'FFA1-999', 'FFA1-1000', 'ffa1-1001']);
  });

  it('el mismo número con ceros a la izquierda empata', () => {
    expect(compareImportedInvoiceNumbers('FFA1-00001419', 'FFA1-1419')).toBe(0);
  });

  it.each([
    ['FFA1-00001419', 'FFA1-1419', true],
    ['FFA1-00001419', '1419', true],
    ['FFA1-00001419', 'ffa1-14', true],
    ['FFA1-00001419', 'FFA1-0001419', true],
    ['FFA1-1419', 'BBV1', false],
    ['FFA1-1419', '', false],
    ['FFA1-00001419', '000', false],
    ['FFA1-00001419', '0', false],
    ['FFA1-00001419', '12', false],
    ['FFA1-00001419', '001419', true],
    ['F001-00000012', '0000001', false],
    [null, 'FFA1', false],
  ])('el buscador: %s contiene %j → %s', (value, search, expected) => {
    expect(invoiceNumberContains(value, search)).toBe(expected);
  });
});

describe('quotationInvoiceState — los cuatro estados', () => {
  const doc = (id: string, number: string) => ({ id, number });

  it('solo referencia: número en la marca y ningún comprobante vigente', () => {
    const state = quotationInvoiceState('FFA1-1419', []);
    expect(state).toEqual({ kind: 'REFERENCE', reference: 'FFA1-1419' });
    expect(shownInvoiceNumber(state)).toBe('FFA1-1419');
  });

  it('registrado: el comprobante coincide con la marca, aunque traiga ceros', () => {
    const state = quotationInvoiceState('FFA1-1419', [doc('d-1', 'FFA1-00001419')]);
    expect(state.kind).toBe('REGISTERED');
    expect(shownInvoiceNumber(state)).toBe('FFA1-00001419');
  });

  it('registrado: una cotización no importada con comprobante', () => {
    const state = quotationInvoiceState(null, [doc('d-1', 'F001-00000012')]);
    expect(state).toEqual({
      kind: 'REGISTERED',
      reference: null,
      documents: [doc('d-1', 'F001-00000012')],
    });
  });

  it('registrado con varios: basta que uno coincida, y se muestra el primero', () => {
    const state = quotationInvoiceState('FFA1-1419', [
      doc('d-1', 'FFA1-00001400'),
      doc('d-2', 'FFA1-00001419'),
    ]);
    expect(state.kind).toBe('REGISTERED');
    expect(shownInvoiceNumber(state)).toBe('FFA1-00001400');
  });

  it('no coincide: hay comprobante vigente con otro número', () => {
    const state = quotationInvoiceState('FFA1-1419', [doc('d-1', 'FFA1-00001420')]);
    expect(state).toEqual({
      kind: 'MISMATCH',
      reference: 'FFA1-1419',
      documents: [doc('d-1', 'FFA1-00001420')],
    });
    expect(shownInvoiceNumber(state)).toBe('FFA1-00001420');
  });

  it('sin nada: ni marca ni comprobante', () => {
    const state = quotationInvoiceState(null, []);
    expect(state).toEqual({ kind: 'NONE' });
    expect(shownInvoiceNumber(state)).toBeNull();
  });
});

describe('orderByInvoiceNumber — la lista ordenada por la columna', () => {
  const row = (seq: number, invoice: string | null) => ({ seq, invoice });
  const rows = [
    row(1, null),
    row(2, 'FFA1-1000'),
    row(3, null),
    row(4, 'FFA1-00000999'),
    row(5, 'BBV1-347'),
    row(6, 'FFA1-999'),
  ];

  it('ascendente: serie y número, ceros fuera; el número de cotización desempata', () => {
    expect(orderByInvoiceNumber(rows, 'asc').map((r) => r.seq)).toEqual([5, 6, 4, 2, 3, 1]);
  });

  it('descendente: las que tienen número siguen primero; las demás, detrás', () => {
    expect(orderByInvoiceNumber(rows, 'desc').map((r) => r.seq)).toEqual([2, 6, 4, 5, 3, 1]);
  });

  it('sin dirección es ascendente, y no cambia el arreglo recibido', () => {
    const copy = [...rows];
    expect(orderByInvoiceNumber(rows)).toEqual(orderByInvoiceNumber(rows, 'asc'));
    expect(rows).toEqual(copy);
  });

  it('«invoice» no tiene fragmento de orderBy: Prisma recibe el orden de siempre', () => {
    expect(quotationOrderBy({ sort: 'invoice', dir: 'desc' })).toEqual([{ seq: 'desc' }]);
  });

  it('la clave se acepta en la query de la lista', () => {
    expect(quotationQuerySchema.parse({ sort: 'invoice', dir: 'desc' })).toMatchObject({
      sort: 'invoice',
      dir: 'desc',
    });
  });
});

describe('QuotationsService.findAll — columna, buscador y orden (D-387)', () => {
  const D = (v: string) => new Prisma.Decimal(v);
  const fullRow = (
    id: string,
    seq: number,
    notes: string | null,
    documents: { id: string; number: string }[] = [],
  ) => ({
    id,
    seq,
    notes,
    status: 'EMITTED',
    issueDate: new Date('2026-09-08T00:00:00Z'),
    validUntil: null,
    subtotalPen: D('100'),
    igvPen: D('18'),
    totalPen: D('118'),
    pdfKey: null,
    customer: { id: 'c-1', name: 'Cliente', docNumber: '20123456789' },
    salesOrders: documents.length > 0 ? [{ id: `o-${id}`, seq, fiscalDocuments: documents }] : [],
    items: [],
    createdById: 'u-1',
    sellerId: 'u-1',
    createdAt: new Date('2026-09-08T00:00:00Z'),
    emittedAt: null,
    confirmedAt: null,
    cancelledAt: null,
    _count: { items: 1 },
  });
  // q-1 sin nada · q-2 solo referencia · q-3 registrado · q-4 no coincide · q-5 no importada con comprobante
  const ROWS = [
    fullRow('q-1', 1, 'Entregar en obra'),
    fullRow('q-2', 2, 'Factura externa: FFA1-1000'),
    fullRow('q-3', 3, 'Factura externa: FFA1-999', [{ id: 'd-3', number: 'FFA1-00000999' }]),
    fullRow('q-4', 4, 'Factura externa: BBV1-347\nVer FFA1-1419', [
      { id: 'd-4', number: 'BBV1-00000348' },
    ]),
    fullRow('q-5', 5, null, [{ id: 'd-5', number: 'AAA1-00000007' }]),
  ];

  function service() {
    const findMany = jest.fn(
      (args: {
        where?: { id?: { in: string[] } };
        select?: unknown;
        skip?: number;
      }): Promise<unknown[]> => {
        if (args.select)
          return Promise.resolve(
            ROWS.map(({ id, seq, notes, salesOrders }) => ({ id, seq, notes, salesOrders })),
          );
        const ids = args.where?.id?.in;
        return Promise.resolve(ids ? ROWS.filter((r) => ids.includes(r.id)) : ROWS);
      },
    );
    const documents = jest.fn((): Promise<unknown[]> => Promise.resolve([]));
    const count = jest.fn().mockResolvedValue(ROWS.length);
    const svc = Object.create(QuotationsService.prototype) as QuotationsService;
    Object.assign(svc, {
      prisma: {
        quotation: { findMany, count },
        fiscalDocument: { findMany: documents },
        user: { findMany: jest.fn().mockResolvedValue([{ id: 'u-1', name: 'Admin' }]) },
      },
    });
    return { svc, findMany, documents, count };
  }
  const admin = { id: 'u-1', role: Role.ADMINISTRADOR } as never;

  it('cada fila trae la marca y los comprobantes vigentes; el estado sale de los dos', async () => {
    const { svc } = service();
    const page = await svc.findAll(admin, quotationQuerySchema.parse({}));
    expect(
      page.items.map((q) => quotationInvoiceState(q.externalInvoice, q.invoiceDocuments).kind),
    ).toEqual(['NONE', 'REFERENCE', 'REGISTERED', 'MISMATCH', 'REGISTERED']);
    expect(page.items[3]?.invoiceDocuments).toEqual([{ id: 'd-4', number: 'BBV1-00000348' }]);
  });

  it('sort=invoice: ordena por el número mostrado, con dos consultas y sin count', async () => {
    const { svc, findMany, count } = service();
    const page = await svc.findAll(
      admin,
      quotationQuerySchema.parse({ sort: 'invoice', dir: 'asc', pageSize: '3' }),
    );
    // AAA1-7 (registrado) · BBV1-348 (registrado, no coincide con la marca BBV1-347) · FFA1-999
    expect(page.items.map((q) => q.code)).toEqual(['COT-000005', 'COT-000004', 'COT-000003']);
    expect(page.total).toBe(5);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(count).not.toHaveBeenCalled();

    const second = await svc.findAll(
      admin,
      quotationQuerySchema.parse({ sort: 'invoice', dir: 'asc', pageSize: '3', page: '2' }),
    );
    expect(second.items.map((q) => q.code)).toEqual(['COT-000002', 'COT-000001']);
  });

  it('el buscador encuentra por la marca (no por otro número de las observaciones) y por el comprobante registrado', async () => {
    const { svc, findMany, documents } = service();
    findMany.mockImplementationOnce(() =>
      Promise.resolve([
        { id: 'q-3', notes: 'Factura externa: FFA1-999' },
        { id: 'q-4', notes: 'Factura externa: BBV1-347\nVer FFA1-1419' },
      ]),
    );
    documents.mockImplementationOnce(() =>
      Promise.resolve([
        { number: 'FFA1-00000999', salesOrder: { quotationId: 'q-3' } },
        { number: 'FFA1-00001500', salesOrder: { quotationId: 'q-9' } },
      ]),
    );
    await svc.findAll(admin, quotationQuerySchema.parse({ search: 'ffa1-999' }));
    const [searchArgs, listArgs] = findMany.mock.calls.map((c) => c[0]) as {
      where: { AND?: unknown; OR?: unknown[] };
    }[];
    // Con serie, Postgres acota por el prefijo; la comparación normalizada decide en memoria.
    expect(searchArgs?.where.AND).toEqual([
      { notes: { startsWith: 'Factura externa: ' } },
      { notes: { startsWith: 'Factura externa: FFA1', mode: 'insensitive' } },
    ]);
    const docArgs = documents.mock.calls[0] as unknown as [
      { where: { number: unknown; status: unknown; docType: unknown; archivedAt: unknown } },
    ];
    expect(docArgs[0].where).toMatchObject({
      number: { startsWith: 'FFA1-', mode: 'insensitive' },
      docType: { in: ['FACTURA', 'BOLETA'] },
      status: { in: ['ISSUED', 'SEND_ERROR', 'ACCEPTED', 'VOID_PENDING'] },
      archivedAt: null,
    });
    expect(listArgs?.where.OR).toContainEqual({ id: { in: ['q-3'] } });
  });

  it('busca por la marca aunque no coincida con el comprobante registrado', async () => {
    const { svc, findMany } = service();
    findMany.mockImplementationOnce(() =>
      Promise.resolve([{ id: 'q-4', notes: 'Factura externa: BBV1-347\nVer FFA1-1419' }]),
    );
    await svc.findAll(admin, quotationQuerySchema.parse({ search: 'BBV1-347' }));
    const listArgs = findMany.mock.calls[1]?.[0] as { where: { OR: unknown[] } };
    expect(listArgs.where.OR).toContainEqual({ id: { in: ['q-4'] } });
  });

  it('sin coincidencias, el buscador no agrega la condición', async () => {
    const { svc, findMany } = service();
    findMany.mockImplementationOnce(() =>
      Promise.resolve([{ id: 'q-4', notes: 'Factura externa: BBV1-347\nVer FFA1-1419' }]),
    );
    await svc.findAll(admin, quotationQuerySchema.parse({ search: 'Factura' }));
    const listArgs = findMany.mock.calls[1]?.[0] as { where: { OR: unknown[] } };
    expect(listArgs.where.OR).not.toContainEqual(
      expect.objectContaining({ id: expect.anything() }),
    );
  });

  it('buscar un RUC no compara contra el correlativo (no cabe en INT4: era un 500)', async () => {
    const { svc, findMany } = service();
    findMany.mockImplementationOnce(() => Promise.resolve([]));
    await svc.findAll(admin, quotationQuerySchema.parse({ search: '20134615804' }));
    const listArgs = findMany.mock.calls[1]?.[0] as { where: { OR: unknown[] } };
    expect(listArgs.where.OR).toEqual([
      { customer: { name: { contains: '20134615804', mode: 'insensitive' } } },
      { customer: { docNumber: { contains: '20134615804' } } },
    ]);
  });

  it('un vendedor solo ve lo suyo: buscar y ordenar por comprobante conservan su alcance', async () => {
    const { svc, findMany } = service();
    const seller = { id: 'u-7', role: Role.VENDEDOR } as never;
    findMany.mockImplementationOnce(() =>
      Promise.resolve([{ id: 'q-3', notes: 'Factura externa: FFA1-999' }]),
    );
    await svc.findAll(seller, quotationQuerySchema.parse({ search: 'FFA1', sort: 'invoice' }));
    // La búsqueda por comprobante solo aporta ids al OR; el filtro que los cruza lleva el alcance.
    const [, keysArgs] = findMany.mock.calls.map((c) => c[0]) as {
      where: { sellerId?: string; OR?: unknown[] };
    }[];
    expect(keysArgs?.where.sellerId).toBe('u-7');
    expect(keysArgs?.where.OR).toContainEqual({ id: { in: ['q-3'] } });
  });

  it('la lista y el orden piden solo los vigentes del pedido vivo: ni anulados, ni borradores, ni notas de crédito', async () => {
    const LIVE_FILTER = {
      where: {
        docType: { in: ['FACTURA', 'BOLETA'] },
        status: { in: ['ISSUED', 'SEND_ERROR', 'ACCEPTED', 'VOID_PENDING'] },
        archivedAt: null,
        number: { not: null },
      },
      select: { id: true, number: true },
      orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
    };
    const LIVE_ORDER = { where: { status: { not: 'CANCELLED' } }, take: 1 };
    const { svc, findMany } = service();
    await svc.findAll(admin, quotationQuerySchema.parse({}));
    await svc.findAll(admin, quotationQuerySchema.parse({ sort: 'invoice' }));
    const [list, keys, page] = findMany.mock.calls.map((c) => c[0]) as {
      include?: { salesOrders: { select: { fiscalDocuments: unknown } } };
      select?: { salesOrders: { select: { fiscalDocuments: unknown } } };
    }[];
    for (const orders of [
      list?.include?.salesOrders,
      keys?.select?.salesOrders,
      page?.include?.salesOrders,
    ]) {
      expect(orders).toMatchObject(LIVE_ORDER);
      expect(orders?.select.fiscalDocuments).toEqual(LIVE_FILTER);
    }
  });

  it('con menos de tres caracteres significativos no busca por comprobante', async () => {
    const { svc, findMany, documents } = service();
    await svc.findAll(admin, quotationQuerySchema.parse({ search: '000' }));
    expect(documents).not.toHaveBeenCalled();
    // Solo `count` y la página: ninguna consulta de candidatos.
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
