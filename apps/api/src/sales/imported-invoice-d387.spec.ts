import { Prisma } from '@prisma/client';
import {
  compareImportedInvoiceNumbers,
  importedInvoiceNumber,
  quotationQuerySchema,
  Role,
} from '@ayr/shared';
import { orderByImportedInvoice, quotationOrderBy } from '../common/list-orderings';
import { QuotationsService } from './quotations.service';

/**
 * D-387 — el comprobante de una cotización importada, en la lista de cotizaciones.
 *
 * El número vive solo en la marca del importador (`Factura externa: <SERIE - NÚMERO>`, primera
 * línea de las observaciones, D-152). `importedInvoiceNumber` es la única lectura: la columna, el
 * buscador y el orden pasan por ella, y lo que no calza queda vacío.
 */

describe('importedInvoiceNumber — la lectura de la marca', () => {
  it.each([
    ['Factura externa: FFA1-1419', 'FFA1-1419'],
    ['Factura externa: BBV1-347', 'BBV1-347'],
    ['Factura externa: FFA1-00001419', 'FFA1-00001419'],
    ['Factura externa: ffa1-1419', 'ffa1-1419'],
    ['Factura externa: FFA1-1350\nEntregar en obra', 'FFA1-1350'],
    ['Factura externa:  FFA1-1419  ', 'FFA1-1419'],
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

describe('compareImportedInvoiceNumbers — serie y correlativo como número', () => {
  it('ordena por serie y después por correlativo numérico', () => {
    const sorted = ['FFA1-1000', 'BBV1-347', 'FFA1-999', 'ffa1-1001', 'BBV1-0341'].sort(
      compareImportedInvoiceNumbers,
    );
    expect(sorted).toEqual(['BBV1-0341', 'BBV1-347', 'FFA1-999', 'FFA1-1000', 'ffa1-1001']);
  });

  it('el mismo número con ceros a la izquierda empata', () => {
    expect(compareImportedInvoiceNumbers('FFA1-00001419', 'FFA1-1419')).toBe(0);
  });
});

describe('orderByImportedInvoice — la lista ordenada por la columna', () => {
  const row = (seq: number, notes: string | null) => ({ seq, notes });
  const rows = [
    row(1, 'Entregar en obra'),
    row(2, 'Factura externa: FFA1-1000'),
    row(3, null),
    row(4, 'Factura externa: FFA1-999'),
    row(5, 'Factura externa: BBV1-347'),
    row(6, 'Factura externa: FFA1-999'),
  ];

  it('ascendente: importadas por serie y número, el número de cotización desempata', () => {
    expect(orderByImportedInvoice(rows, 'asc').map((r) => r.seq)).toEqual([5, 6, 4, 2, 3, 1]);
  });

  it('descendente: las importadas siguen primero; las demás, detrás', () => {
    expect(orderByImportedInvoice(rows, 'desc').map((r) => r.seq)).toEqual([2, 6, 4, 5, 3, 1]);
  });

  it('sin dirección es ascendente, y no cambia el arreglo recibido', () => {
    const copy = [...rows];
    expect(orderByImportedInvoice(rows)).toEqual(orderByImportedInvoice(rows, 'asc'));
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
  const fullRow = (id: string, seq: number, notes: string | null) => ({
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
    salesOrders: [],
    items: [],
    createdById: 'u-1',
    sellerId: 'u-1',
    createdAt: new Date('2026-09-08T00:00:00Z'),
    emittedAt: null,
    confirmedAt: null,
    cancelledAt: null,
    _count: { items: 1 },
  });
  const ROWS = [
    fullRow('q-1', 1, 'Entregar en obra'),
    fullRow('q-2', 2, 'Factura externa: FFA1-1000'),
    fullRow('q-3', 3, 'Factura externa: FFA1-999'),
    fullRow('q-4', 4, 'Factura externa: BBV1-347\nVer FFA1-1419'),
  ];

  function service() {
    const findMany = jest.fn(
      (args: {
        where?: { id?: { in: string[] } };
        select?: unknown;
        skip?: number;
      }): Promise<unknown[]> => {
        if (args.select)
          return Promise.resolve(ROWS.map(({ id, seq, notes }) => ({ id, seq, notes })));
        const ids = args.where?.id?.in;
        return Promise.resolve(ids ? ROWS.filter((r) => ids.includes(r.id)) : ROWS);
      },
    );
    const count = jest.fn().mockResolvedValue(ROWS.length);
    const svc = Object.create(QuotationsService.prototype) as QuotationsService;
    Object.assign(svc, {
      prisma: {
        quotation: { findMany, count },
        user: { findMany: jest.fn().mockResolvedValue([{ id: 'u-1', name: 'Admin' }]) },
      },
    });
    return { svc, findMany, count };
  }
  const admin = { id: 'u-1', role: Role.ADMINISTRADOR } as never;

  it('cada fila trae su comprobante; vacío en la no importada', async () => {
    const { svc } = service();
    const page = await svc.findAll(admin, quotationQuerySchema.parse({}));
    expect(page.items.map((q) => q.externalInvoice)).toEqual([
      null,
      'FFA1-1000',
      'FFA1-999',
      'BBV1-347',
    ]);
  });

  it('sort=invoice: ordena la página y el total con dos consultas, sin count', async () => {
    const { svc, findMany, count } = service();
    const page = await svc.findAll(
      admin,
      quotationQuerySchema.parse({ sort: 'invoice', dir: 'asc', pageSize: '2' }),
    );
    expect(page.items.map((q) => q.code)).toEqual(['COT-000004', 'COT-000003']);
    expect(page.total).toBe(4);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(count).not.toHaveBeenCalled();

    const second = await svc.findAll(
      admin,
      quotationQuerySchema.parse({ sort: 'invoice', dir: 'asc', pageSize: '2', page: '2' }),
    );
    expect(second.items.map((q) => q.code)).toEqual(['COT-000002', 'COT-000001']);
  });

  it('el buscador encuentra por el comprobante de la marca, no por otro número de las observaciones', async () => {
    const { svc, findMany } = service();
    // Postgres devuelve las importadas que mencionan el texto; la lectura de la marca decide.
    findMany.mockImplementationOnce(() =>
      Promise.resolve([
        { id: 'q-3', notes: 'Factura externa: FFA1-999' },
        { id: 'q-4', notes: 'Factura externa: BBV1-347\nVer FFA1-1419' },
      ]),
    );
    await svc.findAll(admin, quotationQuerySchema.parse({ search: 'ffa1-' }));
    const [searchArgs, listArgs] = findMany.mock.calls.map((c) => c[0]) as {
      where: { AND?: unknown; OR?: unknown[] };
    }[];
    expect(searchArgs?.where.AND).toEqual([
      { notes: { startsWith: 'Factura externa: ' } },
      { notes: { contains: 'ffa1-', mode: 'insensitive' } },
    ]);
    expect(listArgs?.where.OR).toContainEqual({ id: { in: ['q-3'] } });
  });

  it('sin coincidencias en la marca, el buscador no agrega la condición', async () => {
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
});
