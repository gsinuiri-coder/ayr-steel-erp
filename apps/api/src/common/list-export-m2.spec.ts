import { Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Role } from '@ayr/shared';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { CustomersController } from '../customers/customers.controller';
import { InvoicingController } from '../invoicing/invoicing.controller';
import { PurchasesController } from '../purchases/purchases.controller';
import { SalesController } from '../sales/sales.controller';

/**
 * cc26 M2 (D-provisional): las rutas de Excel de pedidos, compras, clientes y «Por cliente» de
 * cobranzas. Mismos roles que su lista —ninguno se cambia (D-439)—, declaradas antes de la ruta
 * `:id` cuando la hay, y el controlador entrega el archivo con el rol del usuario.
 */

type Ctor = abstract new (...args: never[]) => unknown;

/** Los roles efectivos de un método: los suyos o, sin metadata propia, los del controlador. */
function rolesOf(controller: Ctor, method: string): Role[] | undefined {
  const reflector = new Reflector();
  const proto = controller.prototype as Record<string, () => unknown>;
  return (
    reflector.get<Role[] | undefined>(ROLES_KEY, proto[method]!) ??
    reflector.get<Role[] | undefined>(ROLES_KEY, controller)
  );
}

describe.each([
  {
    name: 'pedidos',
    controller: SalesController,
    list: 'findOrders',
    xlsx: 'findOrdersXlsx',
    detail: 'findOrder',
    path: 'orders/xlsx',
    roles: [Role.ADMINISTRADOR, Role.VENDEDOR],
  },
  {
    name: 'compras',
    controller: PurchasesController,
    list: 'findAll',
    xlsx: 'findAllXlsx',
    detail: 'findOne',
    path: 'xlsx',
    roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA],
  },
  {
    name: 'clientes',
    controller: CustomersController,
    list: 'findAll',
    xlsx: 'findAllXlsx',
    detail: 'findOne',
    path: 'xlsx',
    roles: [Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA, Role.VENDEDOR],
  },
  {
    name: 'cobranzas por cliente',
    controller: InvoicingController,
    list: 'receivables',
    xlsx: 'findReceivablesXlsx',
    detail: null,
    path: 'receivables/xlsx',
    roles: [Role.ADMINISTRADOR],
  },
])('Excel de $name — la ruta', ({ controller, list, xlsx, detail, path, roles }) => {
  const proto = controller.prototype as unknown as Record<string, () => unknown>;

  it('tiene los mismos roles que la lista', () => {
    expect(rolesOf(controller, list)).toEqual(roles);
    expect(rolesOf(controller, xlsx)).toEqual(rolesOf(controller, list));
  });

  it('su ruta es la de la lista más /xlsx, antes de `:id`', () => {
    expect(Reflect.getMetadata(PATH_METADATA, proto[xlsx]!)).toBe(path);
    if (detail === null) return;
    const names = Object.getOwnPropertyNames(controller.prototype);
    expect(names.indexOf(xlsx)).toBeGreaterThan(-1);
    expect(names.indexOf(xlsx)).toBeLessThan(names.indexOf(detail));
  });
});

describe('los controladores de M2 entregan el archivo con el rol del usuario', () => {
  function response() {
    return { setHeader: jest.fn(), send: jest.fn() };
  }
  function filenameOf(res: ReturnType<typeof response>): string {
    const call = res.setHeader.mock.calls.find(([h]) => h === 'Content-Disposition') as
      [string, string] | undefined;
    return call?.[1] ?? '';
  }

  it('pedidos: la exportación del servicio con el actor y la query', async () => {
    const orders = { exportAll: jest.fn().mockResolvedValue([]) };
    const controller = new SalesController({} as never, orders as never, {} as never);
    const actor = { id: 'u-1', role: Role.VENDEDOR } as never;
    const res = response();
    const query = { stage: ['CONFIRMED'] } as never;
    await controller.findOrdersXlsx(actor, query, res as never);
    expect(orders.exportAll).toHaveBeenCalledWith(actor, query);
    expect(filenameOf(res)).toMatch(/^attachment; filename="pedidos-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    expect(res.send).toHaveBeenCalledWith(expect.any(Buffer));
  });

  it('compras: la exportación del servicio con la query', async () => {
    const purchases = { exportAll: jest.fn().mockResolvedValue([]) };
    const controller = new PurchasesController(purchases as never, {} as never);
    const res = response();
    const query = { onlyWithBalance: true } as never;
    await controller.findAllXlsx(
      { id: 'u-1', role: Role.SUPERVISOR_PLANTA } as never,
      query,
      res as never,
    );
    expect(purchases.exportAll).toHaveBeenCalledWith(query);
    expect(filenameOf(res)).toMatch(/^attachment; filename="compras-\d{4}-\d{2}-\d{2}\.xlsx"$/);
  });

  it('clientes: la exportación del servicio con la query', async () => {
    const customers = { exportAll: jest.fn().mockResolvedValue([]) };
    const controller = new CustomersController(customers as never, {} as never);
    const res = response();
    const query = { search: 'acero' } as never;
    await controller.findAllXlsx({ id: 'u-1', role: Role.VENDEDOR } as never, query, res as never);
    expect(customers.exportAll).toHaveBeenCalledWith(query);
    expect(filenameOf(res)).toMatch(/^attachment; filename="clientes-\d{4}-\d{2}-\d{2}\.xlsx"$/);
  });

  it('cobranzas por cliente: el resumen entero del servicio', async () => {
    const receivables = { exportReceivables: jest.fn().mockResolvedValue([]) };
    const controller = new InvoicingController(
      {} as never,
      receivables as never,
      {} as never,
      {} as never,
    );
    const res = response();
    await controller.findReceivablesXlsx(
      { id: 'u-1', role: Role.ADMINISTRADOR } as never,
      res as never,
    );
    expect(receivables.exportReceivables).toHaveBeenCalledWith();
    expect(filenameOf(res)).toMatch(
      /^attachment; filename="cobranzas-por-cliente-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
  });
});
