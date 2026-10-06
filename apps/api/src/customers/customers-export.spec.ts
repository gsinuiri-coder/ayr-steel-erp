import * as XLSX from 'xlsx';
import { BadRequestException } from '@nestjs/common';
import {
  customerExportQuerySchema,
  customerQuerySchema,
  LIST_XLSX_MAX_ROWS,
  Role,
  type CustomerDto,
} from '@ayr/shared';
import { customersXlsx } from './customers-xlsx';
import { CustomersService } from './customers.service';

/**
 * cc26 M2 (D-provisional): el Excel de la lista de clientes trae las mismas filas que la
 * pantalla —todas las páginas, en el mismo orden— con su mismo alcance: la lista no filtra por
 * vendedor, así que el archivo tampoco, y no lleva costos para ningún rol.
 */

function fullRow(k: number) {
  return {
    id: `c-${String(k)}`,
    docType: 'RUC',
    docNumber: `20${String(100000000 + k)}`,
    name: `Cliente ${String(k)}`,
    address: null,
    email: k % 2 === 0 ? `c${String(k)}@x.pe` : null,
    phone: k % 3 === 0 ? '999888777' : null,
    creditDays: k % 4 === 0 ? 30 : 0,
    needsReview: k % 5 === 0,
    isSystem: false,
    isActive: k % 6 !== 0,
    createdAt: new Date('2026-09-08T00:00:00Z'),
    updatedAt: new Date('2026-09-08T00:00:00Z'),
  };
}
type Row = ReturnType<typeof fullRow>;

describe('CustomersService.exportAll — el Excel es la lista entera (cc26 M2)', () => {
  let rows: Row[];
  let calls: number;
  let findMany: jest.Mock;
  let count: jest.Mock;
  let svc: CustomersService;

  beforeEach(() => {
    calls = 0;
    rows = Array.from({ length: 11 }, (_, k) => fullRow(k + 1));
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
    svc = Object.create(CustomersService.prototype) as CustomersService;
    Object.assign(svc, { prisma: { customer: { findMany, count } } });
  });

  async function allPages(raw: Record<string, string>) {
    const out: CustomerDto[] = [];
    let total = 0;
    for (let page = 1; ; page += 1) {
      const result = await svc.findAll(
        customerQuerySchema.parse({ ...raw, page: String(page), pageSize: '4' }),
      );
      total = result.total;
      out.push(...result.items);
      if (result.items.length === 0 || out.length >= total) break;
    }
    return { items: out, total };
  }

  it.each([
    ['sin filtros', {}],
    ['con búsqueda y orden', { search: 'Cliente', sort: 'creditDays', dir: 'desc' }],
  ])('%s: las filas son las de todas las páginas, en el mismo orden', async (_, raw) => {
    const list = await allPages(raw);
    const exported = await svc.exportAll(customerExportQuerySchema.parse(raw));
    expect(exported).toHaveLength(list.total);
    expect(exported).toEqual(list.items);
  });

  it('pide a Prisma el mismo filtro y el mismo orden que la lista', async () => {
    const raw = { search: '2010', sort: 'name', dir: 'desc' };
    await svc.findAll(customerQuerySchema.parse(raw));
    const [listArgs] = findMany.mock.calls.at(-1) as [{ where: unknown; orderBy: unknown }];
    await svc.exportAll(customerExportQuerySchema.parse(raw));
    const [exportArgs] = findMany.mock.calls.at(-1) as [{ where: unknown; orderBy: unknown }];
    expect(exportArgs.where).toEqual(listArgs.where);
    expect(exportArgs.orderBy).toEqual(listArgs.orderBy);
  });

  it('la fila final cuenta los clientes exportados', async () => {
    const exported = await svc.exportAll(customerExportQuerySchema.parse({}));
    const file = customersXlsx(exported, Role.VENDEDOR, '2026-10-06');
    const book = XLSX.read(file.buffer, { type: 'buffer' });
    const grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets.Clientes!, { header: 1 });
    expect(grid).toHaveLength(1 + exported.length + 1);
    expect(grid.at(-1)).toEqual([`Total (${String(exported.length)} clientes)`]);
    expect(file.filename).toBe('clientes-2026-10-06.xlsx');
  });

  it('las consultas no crecen con las filas', async () => {
    async function callsFor(n: number) {
      rows = rows.slice(0, n);
      calls = 0;
      await svc.exportAll(customerExportQuerySchema.parse({}));
      return calls;
    }
    const few = await callsFor(2);
    const many = await callsFor(10);
    expect(many).toBe(few);
    // Medido: 2 (count, filas).
    expect(many).toBe(2);
  });

  it(`más de ${String(LIST_XLSX_MAX_ROWS)} filas: 400 sin cargar ninguna`, async () => {
    count.mockResolvedValueOnce(LIST_XLSX_MAX_ROWS + 1);
    await expect(svc.exportAll(customerExportQuerySchema.parse({}))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('customersXlsx — columnas y celdas', () => {
  const base: CustomerDto = {
    id: '00000000-0000-4000-8000-000000000001',
    docType: 'RUC',
    docNumber: '20123456789',
    name: 'Cliente',
    address: null,
    email: null,
    phone: '999888777',
    creditDays: 30,
    needsReview: true,
    isSystem: false,
    isActive: false,
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
  };

  function grid(rows: CustomerDto[], role: Role): unknown[][] {
    const book = XLSX.read(customersXlsx(rows, role, '2026-10-06').buffer, { type: 'buffer' });
    return XLSX.utils.sheet_to_json<unknown[]>(book.Sheets.Clientes!, { header: 1 });
  }

  it('todos los roles de la lista reciben las mismas columnas, sin costos', () => {
    const admin = grid([], Role.ADMINISTRADOR)[0];
    expect(grid([], Role.VENDEDOR)[0]).toEqual(admin);
    expect(grid([], Role.SUPERVISOR_PLANTA)[0]).toEqual(admin);
    expect((admin as string[]).join('|')).not.toMatch(/costo|margen|piso/i);
  });

  it('la fila dice lo que dice la pantalla', () => {
    const [, row] = grid([base], Role.VENDEDOR);
    expect(row).toEqual(['RUC', '20123456789', 'Cliente', 'Sí', '999888777', 30, 'Inactivo']);
  });
});
