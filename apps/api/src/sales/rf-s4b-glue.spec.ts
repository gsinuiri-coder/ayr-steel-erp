import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BusinessLineCode, Prisma } from '@prisma/client';
import { QuotationsService } from './quotations.service';
import { SalesController } from './sales.controller';
import type { SalesOrderEditsService } from './sales-order-edits.service';
import { SalesOrdersService } from './sales-orders.service';
import { coilPoolFor, coilPoolKeyOfProduct } from './coil-sale-product';

jest.mock('./coil-sale-product', () => ({
  coilPoolFor: jest.fn(),
  coilPoolKeyOfProduct: jest.fn(),
}));

/**
 * RF-S4b — el pegamento que no tenía dónde probarse: los importes del papel que sobreviven a la
 * edición de una cotización importada (D-169/D-255), `GET /sales/coil-pool` y las rutas nuevas
 * del controlador.
 */

const D = (v: string) => new Prisma.Decimal(v);

describe('QuotationsService.withImportedAmounts (edición de una cotización importada)', () => {
  const stored = (over: Partial<Record<string, Prisma.Decimal | string>> = {}) => ({
    productId: 'p-1',
    qty: D('3840'),
    unitPricePen: D('3.0508'),
    subtotalPen: D('11715.2540'),
    igvPen: D('2108.7457'),
    totalPen: D('13824.0000'),
    ...over,
  });
  const run = (
    rows: ReturnType<typeof stored>[],
    items: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> => {
    const service = Object.create(QuotationsService.prototype) as {
      withImportedAmounts: (
        tx: unknown,
        id: string,
        items: unknown[],
      ) => Promise<Record<string, unknown>[]>;
    };
    const tx = { quotationItem: { findMany: jest.fn().mockResolvedValue(rows) } };
    return service.withImportedAmounts(tx, 'q-1', items);
  };

  it('una línea que no se tocó recupera los tres importes del papel y pierde el unitario tipeado', async () => {
    const [line] = await run(
      [stored()],
      [{ productId: 'p-1', qty: '3840.000', unitPricePen: '3.0508' }],
    );
    expect(line).toMatchObject({
      netAmountPen: '11715.2540',
      igvAmountPen: '2108.7457',
      totalAmountPen: '13824.0000',
    });
    expect(line).not.toHaveProperty('unitPricePen');
  });

  it('si cambió el precio, la línea se recalcula: no se le pega el importe viejo', async () => {
    const [line] = await run(
      [stored()],
      [{ productId: 'p-1', qty: '3840.000', unitPricePen: '4.0000' }],
    );
    expect(line).not.toHaveProperty('netAmountPen');
    expect(line).toMatchObject({ unitPricePen: '4.0000' });
  });

  it('si cambió la cantidad, tampoco', async () => {
    const [line] = await run(
      [stored()],
      [{ productId: 'p-1', qty: '100.000', unitPricePen: '3.0508' }],
    );
    expect(line).not.toHaveProperty('netAmountPen');
  });

  it('una línea de bobina con el importe guardado recupera el IGV y el total del papel', async () => {
    const [line] = await run(
      [stored()],
      [{ saleCoilId: 'c-1', qty: '3840.000', netAmountPen: '11715.2540' }],
    );
    expect(line).toMatchObject({
      saleCoilId: 'c-1',
      igvAmountPen: '2108.7457',
      totalAmountPen: '13824.0000',
    });
  });

  it('una línea que ya trae el trío no se toca', async () => {
    const own = {
      saleCoilId: 'c-1',
      qty: '3840.000',
      netAmountPen: '11715.2540',
      igvAmountPen: '1.0000',
      totalAmountPen: '11716.2540',
    };
    const [line] = await run([stored()], [own]);
    expect(line).toEqual(own);
  });

  it('un importe distinto al guardado se deja como viene', async () => {
    const own = { saleCoilId: 'c-1', qty: '3840.000', netAmountPen: '999.0000' };
    const [line] = await run([stored()], [own]);
    expect(line).toEqual(own);
  });

  it('dos líneas idénticas reciben cada una su propio importe, no dos veces el primero', async () => {
    const rows = [
      stored(),
      stored({ subtotalPen: D('11715.2000'), igvPen: D('2108.7360'), totalPen: D('13823.9360') }),
    ];
    const item = { productId: 'p-1', qty: '3840.000', unitPricePen: '3.0508' };
    const lines = await run(rows, [item, item]);
    expect(lines.map((l) => l.netAmountPen)).toEqual(['11715.2540', '11715.2000']);
  });

  it('una línea sin producto ni precio se deja como viene', async () => {
    const own = { qty: '1.000' };
    const [line] = await run([stored()], [own]);
    expect(line).toEqual(own);
  });
});

describe('SalesOrdersService.coilPool — GET /sales/coil-pool', () => {
  const build = (product: unknown) => {
    const service = Object.create(SalesOrdersService.prototype) as SalesOrdersService;
    Object.assign(service, {
      prisma: { product: { findUnique: jest.fn().mockResolvedValue(product) } },
    });
    return service;
  };
  const query = { productId: '11111111-1111-4111-8111-111111111111', qty: '4194.000' };
  const prod = { sku: 'BOB38AZUL', name: 'x', businessLine: { code: BusinessLineCode.TRADING } };

  beforeEach(() => jest.clearAllMocks());

  it('devuelve el pool con el SKU canónico', async () => {
    (coilPoolKeyOfProduct as jest.Mock).mockResolvedValue({
      sku: 'BOB038AZUL',
      thicknessMm: '0.38',
      attribute: 'AZUL',
    });
    (coilPoolFor as jest.Mock).mockResolvedValue({
      availableKg: '4194.000',
      candidates: [],
      autoCoilId: null,
    });
    const pool = await build(prod).coilPool({
      ...query,
      exceptSalesOrderId: 'o-1',
      exceptQuotationId: 'q-1',
    });
    expect(pool).toEqual({
      sku: 'BOB038AZUL',
      availableKg: '4194.000',
      candidates: [],
      autoCoilId: null,
    });
    // El propio documento no le quita candidatas.
    const poolCalls = (coilPoolFor as jest.Mock).mock.calls as unknown[][];
    expect(poolCalls[0]?.[3]).toEqual({
      exceptSalesOrderIds: ['o-1'],
      exceptQuotationIds: ['q-1'],
    });
  });

  it('un producto que no existe es un 404', async () => {
    await expect(build(null).coilPool(query)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un producto que no es de venta de bobina es un 400', async () => {
    (coilPoolKeyOfProduct as jest.Mock).mockResolvedValue(null);
    await expect(build(prod).coilPool(query)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SalesController — rutas de RF-S4b', () => {
  const orders = { coilPool: jest.fn().mockResolvedValue({ sku: 'BOB038AZUL' }) };
  const edits = { updateItemCoil: jest.fn().mockResolvedValue({ id: 'o-1' }) };
  const controller = new SalesController(
    {} as QuotationsService,
    orders as unknown as SalesOrdersService,
    edits as unknown as SalesOrderEditsService,
  );

  it('PATCH orders/:id/items/:itemId/coil delega en la edición del pedido', async () => {
    const actor = { id: 'u-1' } as never;
    const body = { saleCoilId: 'c-1', reason: 'porque sí' };
    await expect(controller.updateOrderItemCoil(actor, 'o-1', 'i-1', body)).resolves.toEqual({
      id: 'o-1',
    });
    expect(edits.updateItemCoil).toHaveBeenCalledWith(actor, 'o-1', 'i-1', body);
  });

  it('GET coil-pool delega en el servicio de pedidos', async () => {
    const query = { productId: 'p-1', qty: '1.000' };
    await controller.coilPool(query);
    expect(orders.coilPool).toHaveBeenCalledWith(query);
  });
});
