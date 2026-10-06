import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import { LIST_XLSX_MAX_ROWS, Role } from '@ayr/shared';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { InvoicingController } from '../invoicing/invoicing.controller';
import { SalesController } from '../sales/sales.controller';
import { assertExportable, exportWindow, pageWindow } from './list-export';

/**
 * cc26 (D-provisional): las rutas de Excel de las listas. Mismos roles que la lista (heredados del
 * controlador, sin metadata propia), declaradas antes de la ruta `:id` y con el tope de filas.
 */

describe('ventanas y tope', () => {
  it('la página de la lista es skip/take sin tope; la exportación, todo hasta el tope', () => {
    expect(pageWindow({ page: 3, pageSize: 50 })).toEqual({ skip: 100, take: 50 });
    expect(exportWindow()).toEqual({
      skip: 0,
      take: LIST_XLSX_MAX_ROWS,
      maxTotal: LIST_XLSX_MAX_ROWS,
    });
  });

  it('pasado el tope, 400; en el tope, nada; la lista nunca', () => {
    expect(() => {
      assertExportable(LIST_XLSX_MAX_ROWS + 1, exportWindow());
    }).toThrow(BadRequestException);
    expect(() => {
      assertExportable(LIST_XLSX_MAX_ROWS, exportWindow());
    }).not.toThrow();
    expect(() => {
      assertExportable(1_000_000, pageWindow({ page: 1, pageSize: 50 }));
    }).not.toThrow();
  });
});

describe.each([
  {
    name: 'comprobantes',
    controller: InvoicingController,
    list: 'findAll',
    xlsx: 'findAllXlsx',
    detail: 'findOne',
    path: 'documents/xlsx',
  },
  {
    name: 'cotizaciones',
    controller: SalesController,
    list: 'findQuotations',
    xlsx: 'findQuotationsXlsx',
    detail: 'findQuotation',
    path: 'quotations/xlsx',
  },
])('Excel de $name — la ruta', ({ controller, list, xlsx, detail, path }) => {
  const reflector = new Reflector();
  const proto = controller.prototype as unknown as Record<string, () => unknown>;

  it('tiene los mismos roles que la lista: los del controlador, ADMINISTRADOR y VENDEDOR', () => {
    expect(reflector.get<Role[] | undefined>(ROLES_KEY, proto[xlsx]!)).toBeUndefined();
    expect(reflector.get<Role[] | undefined>(ROLES_KEY, proto[list]!)).toBeUndefined();
    expect(reflector.get<Role[] | undefined>(ROLES_KEY, controller)).toEqual([
      Role.ADMINISTRADOR,
      Role.VENDEDOR,
    ]);
  });

  it(`se declara antes de la ruta \`:id\` (si no, ParseUUIDPipe rechaza «xlsx»)`, () => {
    expect(Reflect.getMetadata(PATH_METADATA, proto[xlsx]!)).toBe(path);
    const names = Object.getOwnPropertyNames(controller.prototype);
    expect(names.indexOf(xlsx)).toBeGreaterThan(-1);
    expect(names.indexOf(xlsx)).toBeLessThan(names.indexOf(detail));
  });
});

describe('los controladores entregan el archivo con el rol del usuario', () => {
  function response() {
    return { setHeader: jest.fn(), send: jest.fn() };
  }

  it('comprobantes: la exportación del servicio con la query y el actor, como xlsx', async () => {
    const invoicing = { exportAll: jest.fn().mockResolvedValue([]) };
    const controller = new InvoicingController(
      invoicing as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const actor = { id: 'u-1', role: Role.VENDEDOR } as never;
    const res = response();
    const query = { search: 'x' } as never;
    await controller.findAllXlsx(actor, query, res as never);
    expect(invoicing.exportAll).toHaveBeenCalledWith(query, actor);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringMatching(/^attachment; filename="comprobantes-\d{4}-\d{2}-\d{2}\.xlsx"$/),
    );
    expect(res.send).toHaveBeenCalledWith(expect.any(Buffer));
  });

  it('cotizaciones: la exportación del servicio con el actor y la query, como xlsx', async () => {
    const quotations = { exportAll: jest.fn().mockResolvedValue([]) };
    const controller = new SalesController(quotations as never, {} as never, {} as never);
    const actor = { id: 'u-1', role: Role.VENDEDOR } as never;
    const res = response();
    const query = { status: 'EMITTED' } as never;
    await controller.findQuotationsXlsx(actor, query, res as never);
    expect(quotations.exportAll).toHaveBeenCalledWith(actor, query);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringMatching(/^attachment; filename="cotizaciones-\d{4}-\d{2}-\d{2}\.xlsx"$/),
    );
  });
});
