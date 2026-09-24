import { BadRequestException } from '@nestjs/common';
import { InventoryItemType, Prisma } from '@prisma/client';
import { Role } from '@ayr/shared';
import type { AuditService } from '../audit/audit.service';
import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import type { RoofingProductionService } from '../production/roofing-production.service';
import { assertPriceFloor } from './price-floor';
import { SalesOrderEditsService } from './sales-order-edits.service';
import type { SalesOrdersService } from './sales-orders.service';
import { resolveSalesLines } from './sales-lines';

/**
 * RF-S4b en la edición de un pedido confirmado, con una base falsa:
 * - D-256: el pedido importado no pasa por el piso al cambiarle el precio, y queda auditado;
 * - D-255: un cambio de importe que no mueve el cuarto decimal del unitario igual se guarda, y el
 *   precio se puede cargar con IGV o por importe de línea;
 * - restablecer los importes del papel solo vale en un pedido importado;
 * - D-254: atar una línea a una bobina solo acepta una del pool, y libera la reserva anterior.
 */

jest.mock('./price-floor', () => ({ assertPriceFloor: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./price-changes', () => ({
  recordPriceChanges: jest.fn().mockResolvedValue(1),
}));
jest.mock('../production/roofing-coil-match', () => ({ roofingToleranceMm: () => '0.05' }));
jest.mock('./sales-lines', () => ({ resolveSalesLines: jest.fn() }));
jest.mock('./coil-sale-product', () => ({
  COIL_SALE_IDENTITY_SELECT: {},
  coilSaleSkus: () => ({ canonical: 'BOB038AZUL', legacy: 'x' }),
  findCoilSaleProducts: jest.fn(),
  coilPoolFor: jest.fn(),
  lineCoilPool: jest.fn(),
}));

import { recordPriceChanges } from './price-changes';
import { coilPoolFor, findCoilSaleProducts, lineCoilPool } from './coil-sale-product';

const D = (v: string) => new Prisma.Decimal(v);
const ADMIN = { id: 'u-1', role: Role.ADMINISTRADOR } as never;
const IMPORTED = 'Factura externa: FFA1-1350';

interface ItemOpts {
  reserve?: InventoryItemType;
  qty?: string;
  subtotal?: string;
  igv?: string;
  total?: string;
  sku?: string;
}
const item = (o: ItemOpts = {}) => ({
  id: 'i-1',
  lineNumber: 1,
  productId: 'p-1',
  description: 'BOBINA',
  qty: D(o.qty ?? '3840'),
  unitPricePen: D('3.0508'),
  valuePerMeterPen: null,
  subtotalPen: D(o.subtotal ?? '11715.2540'),
  igvPen: D(o.igv ?? '2108.7457'),
  totalPen: D(o.total ?? '13824.0000'),
  reserveItemType: o.reserve ?? InventoryItemType.PRODUCT,
  reserveItemId: 'r-1',
  pieces: [],
  product: {
    businessLineId: 'bl-1',
    lengthMm: null,
    sku: o.sku ?? 'BOB38ROJO',
    name: 'Bobina',
    businessLine: { code: 'TRADING' },
  },
});

function build(
  opts: { notes?: string | null; item?: ReturnType<typeof item>; dispatched?: boolean } = {},
) {
  const found = opts.item ?? item();
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([
      {
        id: 'o-1',
        seq: 7,
        status: 'CONFIRMED',
        created_by_id: 'u-1',
        seller_id: null,
        notes: opts.notes === undefined ? IMPORTED : opts.notes,
      },
    ]),
    fiscalDocument: { findFirst: jest.fn().mockResolvedValue(null) },
    salesOrderItem: {
      findFirst: jest.fn().mockResolvedValue(found),
      update: jest.fn().mockResolvedValue({ id: 'i-1' }),
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { subtotalPen: D('11715.2540'), igvPen: D('2108.7457') } }),
    },
    salesOrder: { update: jest.fn().mockResolvedValue({}) },
    dispatchItem: {
      findFirst: jest.fn().mockResolvedValue(opts.dispatched ? { id: 'd-1' } : null),
    },
    reservation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    coil: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'c-2', code: 'SALDO-2' }),
    },
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const orders = {
    findOne: jest.fn().mockResolvedValue({ id: 'o-1' }),
    createReservations: jest.fn().mockResolvedValue(undefined),
  };
  const prisma = { $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  const service = new SalesOrderEditsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    orders as unknown as SalesOrdersService,
    {} as RoofingProductionService,
    {} as Env,
  );
  return { service, tx, audit, orders };
}

beforeEach(() => jest.clearAllMocks());

describe('SalesOrderEditsService.updateItemPrice — D-255/D-256', () => {
  it('un pedido importado no pasa por el piso y la auditoría lo dice', async () => {
    (resolveSalesLines as jest.Mock).mockResolvedValue([
      {
        unitPricePen: '3.0508',
        valuePerMeterPen: null,
        subtotalPen: '11715.2540',
        igvPen: '2108.7457',
        totalPen: '13824.0000',
      },
    ]);
    const { service, audit } = build();
    await service.updateItemPrice(ADMIN, 'o-1', 'i-1', { netAmountPen: '11715.254' });
    const [, , opts] = (resolveSalesLines as jest.Mock).mock.calls[0] as [
      unknown,
      unknown,
      { priceFloor?: unknown },
    ];
    expect(opts.priceFloor).toBeUndefined();
    const entry = (audit.write.mock.calls[0] as [unknown, { after: Record<string, unknown> }])[1];
    expect(entry.after).toMatchObject({
      priceForm: 'IMPORTE_DE_LINEA',
      priceFloorExempt: 'D-163/D-256: pedido importado',
    });
  });

  it('un pedido común sigue pasando por el piso', async () => {
    (resolveSalesLines as jest.Mock).mockResolvedValue([
      {
        unitPricePen: '3.0508',
        valuePerMeterPen: null,
        subtotalPen: '11715.2540',
        igvPen: '2108.7457',
        totalPen: '13824.0000',
      },
    ]);
    const { service, audit } = build({ notes: null });
    await service.updateItemPrice(ADMIN, 'o-1', 'i-1', { unitPriceWithIgvPen: '3.6' });
    const [, , opts] = (resolveSalesLines as jest.Mock).mock.calls[0] as [
      unknown,
      unknown,
      { priceFloor?: { toleranceMm: string } },
    ];
    expect(opts.priceFloor).toEqual({ toleranceMm: '0.05' });
    const entry = (audit.write.mock.calls[0] as [unknown, { after: Record<string, unknown> }])[1];
    expect(entry.after).toMatchObject({ priceForm: 'PRECIO_CON_IGV' });
    expect(entry.after).not.toHaveProperty('priceFloorExempt');
  });

  it('un cambio de importe que no mueve el 4.º decimal del unitario se guarda igual', async () => {
    // 3840 kg: 11715.25 y 11715.20 dan el mismo unitario de cuatro decimales (3.0508).
    (resolveSalesLines as jest.Mock).mockResolvedValue([
      {
        unitPricePen: '3.0508',
        valuePerMeterPen: null,
        subtotalPen: '11715.2000',
        igvPen: '2108.7360',
        totalPen: '13823.9360',
      },
    ]);
    (recordPriceChanges as jest.Mock).mockResolvedValue(0);
    const { service, tx } = build();
    await service.updateItemPrice(ADMIN, 'o-1', 'i-1', { netAmountPen: '11715.20' });
    expect(tx.salesOrderItem.update).toHaveBeenCalledTimes(1);
  });

  it('sin ningún cambio no escribe nada', async () => {
    (resolveSalesLines as jest.Mock).mockResolvedValue([
      {
        unitPricePen: '3.0508',
        valuePerMeterPen: null,
        subtotalPen: '11715.2540',
        igvPen: '2108.7457',
        totalPen: '13824.0000',
      },
    ]);
    (recordPriceChanges as jest.Mock).mockResolvedValue(0);
    const { service, tx, audit } = build();
    await service.updateItemPrice(ADMIN, 'o-1', 'i-1', { netAmountPen: '11715.254' });
    expect(tx.salesOrderItem.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('la venta de una bobina deriva el unitario del importe y respeta el piso solo si no es importada', async () => {
    const coilItem = item({ reserve: InventoryItemType.COIL });
    const imported = build({ item: coilItem });
    await imported.service.updateItemPrice(ADMIN, 'o-1', 'i-1', { unitPriceWithIgvPen: '3.5' });
    expect(assertPriceFloor).not.toHaveBeenCalled();
    // 3.5 con IGV × 3840 kg = 13440.00 → 11389.83 / 2050.17: el total es exacto.
    const set = (
      imported.tx.salesOrderItem.update.mock.calls[0] as [{ data: Record<string, string> }]
    )[0].data;
    expect(set.totalPen).toBe('13440.0000');
    expect(set.valuePerMeterPen).toBeNull();

    const common = build({ item: coilItem, notes: null });
    await common.service.updateItemPrice(ADMIN, 'o-1', 'i-1', { unitPricePen: '3.0000' });
    expect(assertPriceFloor).toHaveBeenCalledTimes(1);
  });

  it('una bobina sin ninguna forma de precio válida rebota', async () => {
    const { service } = build({ item: item({ reserve: InventoryItemType.COIL }) });
    await expect(
      service.updateItemPrice(ADMIN, 'o-1', 'i-1', { valuePerMeterPen: '3' }),
    ).rejects.toThrow(/se cotiza por kg/);
  });
});

describe('SalesOrderEditsService.restorePaperAmounts — D-255', () => {
  it('restablece el importe del papel y registra el antes y el después', async () => {
    const { service, tx, audit } = build();
    await service.restorePaperAmounts(
      ADMIN,
      'o-1',
      'i-1',
      { netAmountPen: '11715.2540', igvAmountPen: '2108.7460', totalAmountPen: '13824.0000' },
      'Barrido',
    );
    const set = (tx.salesOrderItem.update.mock.calls[0] as [{ data: Record<string, unknown> }])[0]
      .data;
    expect(set).toMatchObject({
      subtotalPen: '11715.2540',
      igvPen: '2108.7460',
      totalPen: '13824.0000',
      valuePerMeterPen: null,
    });
    const entry = (audit.write.mock.calls[0] as [unknown, { action: string; reason: string }])[1];
    expect(entry).toMatchObject({ action: 'sales.order.item-paper-amounts', reason: 'Barrido' });
  });

  it('sin IGV ni total del papel calcula el IGV como siempre', async () => {
    const { service, tx } = build();
    await service.restorePaperAmounts(ADMIN, 'o-1', 'i-1', { netAmountPen: '100.0000' }, 'x');
    const set = (tx.salesOrderItem.update.mock.calls[0] as [{ data: Record<string, unknown> }])[0]
      .data;
    expect(set).toMatchObject({ subtotalPen: '100.0000', igvPen: '18.0000', totalPen: '118.0000' });
  });

  it('un pedido que no viene del importador no tiene comprobante de origen', async () => {
    const { service } = build({ notes: null });
    await expect(
      service.restorePaperAmounts(ADMIN, 'o-1', 'i-1', { netAmountPen: '1.0000' }, 'x'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SalesOrderEditsService.updateItemCoil — D-254', () => {
  const POOL = { sku: 'BOB038ROJO', thicknessMm: '0.38', attribute: 'ROJO' };
  const okMocks = () => {
    (lineCoilPool as jest.Mock).mockResolvedValue(POOL);
    (coilPoolFor as jest.Mock).mockResolvedValue({
      availableKg: '4194.000',
      candidates: [{ coilId: 'c-2', code: 'SALDO-2', widthMm: '1200.00', balanceKg: '4194.000' }],
      autoCoilId: 'c-2',
    });
    (findCoilSaleProducts as jest.Mock).mockResolvedValue(
      new Map([
        ['BOB038AZUL', { id: 'p-canon', sku: 'BOB038AZUL', name: 'x', businessLineId: 'bl-t' }],
      ]),
    );
  };
  const input = { saleCoilId: 'c-2', reason: 'Bobina real del pool' };

  it('ata la línea a la bobina elegida, pasa al producto canónico y libera la reserva anterior', async () => {
    okMocks();
    const { service, tx, orders, audit } = build();
    await service.updateItemCoil(ADMIN, 'o-1', 'i-1', input);
    expect(tx.reservation.updateMany).toHaveBeenCalledTimes(1);
    const set = (tx.salesOrderItem.update.mock.calls[0] as [{ data: Record<string, unknown> }])[0]
      .data;
    expect(set).toMatchObject({
      productId: 'p-canon',
      reserveItemType: InventoryItemType.COIL,
      reserveItemId: 'c-2',
      reserveQty: '3840.000',
    });
    expect(orders.createReservations).toHaveBeenCalledTimes(1);
    expect(orders.findOne).toHaveBeenCalledWith('o-1');
    const entry = (
      audit.write.mock.calls[0] as [unknown, { action: string; after: { reason: string } }]
    )[1];
    expect(entry.action).toBe('sales.order.item-coil');
    expect(entry.after.reason).toBe('Bobina real del pool');
    // La propia reserva del pedido no le quita candidatas al pool.
    const poolCalls = (coilPoolFor as jest.Mock).mock.calls as unknown[][];
    expect(poolCalls[0]?.[3]).toEqual({ exceptSalesOrderIds: ['o-1'] });
  });

  it('una bobina fuera del pool se rechaza', async () => {
    okMocks();
    (coilPoolFor as jest.Mock).mockResolvedValue({
      availableKg: '0.000',
      candidates: [],
      autoCoilId: null,
    });
    const { service, tx } = build();
    await expect(service.updateItemCoil(ADMIN, 'o-1', 'i-1', input)).rejects.toThrow(
      /no está en el pool/,
    );
    expect(tx.salesOrderItem.update).not.toHaveBeenCalled();
  });

  it('una línea con despachos no cambia de bobina', async () => {
    okMocks();
    const { service } = build({ dispatched: true });
    await expect(service.updateItemCoil(ADMIN, 'o-1', 'i-1', input)).rejects.toThrow(
      /ya tiene despachos/,
    );
  });

  it('una línea que no es venta de bobina no se ata', async () => {
    (lineCoilPool as jest.Mock).mockResolvedValue(null);
    const { service } = build();
    await expect(service.updateItemCoil(ADMIN, 'o-1', 'i-1', input)).rejects.toThrow(
      /no es una venta de bobina/,
    );
  });

  it('sin producto de venta de la bobina, se rechaza sin escribir', async () => {
    okMocks();
    (findCoilSaleProducts as jest.Mock).mockResolvedValue(new Map());
    const { service, tx } = build();
    await expect(service.updateItemCoil(ADMIN, 'o-1', 'i-1', input)).rejects.toThrow(
      /no existe el producto de venta/,
    );
    expect(tx.reservation.updateMany).not.toHaveBeenCalled();
  });
});

describe('D-256 (aclaración): cambiar la cantidad de un pedido importado', () => {
  const VENDEDOR = { id: 'u-2', role: Role.VENDEDOR } as never;
  const optionsOf = async (actor: never, notes: string | null) => {
    const { service, tx } = build({ notes, item: item({ sku: 'COB-1' }) });
    Object.assign(tx, {
      reservation: { findMany: jest.fn().mockResolvedValue([]) },
      // El pedido es del vendedor que lo edita (D-238).
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'o-1',
          seq: 7,
          status: 'CONFIRMED',
          created_by_id: 'u-2',
          seller_id: 'u-2',
          notes,
        },
      ]),
    });
    const resolve = resolveSalesLines as jest.Mock;
    resolve.mockReset();
    // Se corta apenas se recalcula la línea: lo que importa es con qué opciones.
    resolve.mockRejectedValueOnce(new BadRequestException('corte del test'));
    await expect(service.updateItemQty(actor, 'o-1', 'i-1', { qty: '100.000' })).rejects.toThrow(
      'corte del test',
    );
    return (resolve.mock.calls as unknown[][])[0]?.[2] as Record<string, unknown>;
  };

  it('un VENDEDOR pasa por el piso: la línea deja de representar al comprobante', async () => {
    expect(await optionsOf(VENDEDOR, IMPORTED)).toHaveProperty('priceFloor');
  });

  it('un ADMINISTRADOR sigue exento', async () => {
    expect(await optionsOf(ADMIN, IMPORTED)).not.toHaveProperty('priceFloor');
  });

  it('en un pedido no importado, cambiar la cantidad sigue sin piso (el precio ya lo pasó)', async () => {
    expect(await optionsOf(VENDEDOR, null)).not.toHaveProperty('priceFloor');
  });
});
