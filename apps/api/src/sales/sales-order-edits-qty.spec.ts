import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  InventoryItemType,
  Prisma,
  ProductionOrderKind,
  ProductionOrderStatus,
  ReservationStatus,
} from '@prisma/client';
import { Decimal, Role } from '@ayr/shared';
import type { AuditService } from '../audit/audit.service';
import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import type { RoofingProductionService } from '../production/roofing-production.service';
import { SalesOrderEditsService } from './sales-order-edits.service';
import type { SalesOrdersService } from './sales-orders.service';
import { resolveSalesLines } from './sales-lines';

/**
 * cc45 (D-603, D-604) — «Cambiar cantidad» con producción, con una base falsa: los caminos que el
 * db-spec prueba contra Postgres, acá rama por rama (pisos, permisos, motivo, reserva por objetivo,
 * plan de la OP viva, OP nueva por la diferencia, vista previa, despachos).
 */

jest.mock('../production/roofing-coil-match', () => ({ roofingToleranceMm: () => '0.05' }));
jest.mock('./sales-lines', () => ({ resolveSalesLines: jest.fn() }));
jest.mock('./raw-material', () => ({
  rawMaterialSpecLabels: jest.fn().mockResolvedValue(new Map([['spec-1', 'Bobina 0.40 mm Rojo']])),
}));

const D = (v: string) => new Prisma.Decimal(v);
const ADMIN = { id: 'u-1', role: Role.ADMINISTRADOR } as never;
const SELLER = { id: 'u-1', role: Role.VENDEDOR } as never;
const piece = (m: number, qty: number) => ({ lengthMm: D((m * 1000).toFixed(2)), qty });

interface OrderFake {
  id: string;
  seq: number;
  status: ProductionOrderStatus;
  kind?: ProductionOrderKind;
  items: { lengthMm: Prisma.Decimal; qty: number }[];
  reports: {
    metersM: Prisma.Decimal | null;
    piecesDetail: { lengthMm: Prisma.Decimal; qty: number }[];
  }[];
}

interface Setup {
  unit?: string;
  roofingKind?: string | null;
  lengthMm?: Prisma.Decimal | null;
  qty?: string;
  pieces?: { lengthMm: Prisma.Decimal; qty: number }[];
  reserve?: InventoryItemType;
  reservation?: { status: ReservationStatus; qty: string; shortfall?: string } | null;
  orders?: OrderFake[];
  dispatched?: string;
  document?: boolean;
  orderStatus?: string;
}

function build(setup: Setup = {}) {
  const reserve = setup.reserve ?? InventoryItemType.RAW_MATERIAL;
  const item = {
    id: 'i-1',
    lineNumber: 1,
    productId: 'p-1',
    description: 'COB',
    unit: setup.unit ?? 'MTR',
    qty: D(setup.qty ?? '20'),
    unitPricePen: D('22'),
    valuePerMeterPen: D('22'),
    subtotalPen: D('440'),
    igvPen: D('79.2'),
    totalPen: D('519.2'),
    reserveItemType: reserve,
    reserveItemId: 'spec-1',
    reserveQty: D('121.2'),
    reserveUnit: 'KGM',
    pieces: setup.pieces ?? [piece(6, 2), piece(4, 2)],
    product: {
      businessLineId: 'bl-1',
      lengthMm: setup.lengthMm ?? null,
      sku: 'COB040ROJO',
      name: 'Cobertura',
      roofingKind: setup.roofingKind === undefined ? 'A_MEDIDA' : setup.roofingKind,
      businessLine: { code: 'METALLIC_ROOFING' },
    },
  };
  const orders = (setup.orders ?? []).map((o) => ({
    kind: ProductionOrderKind.ROOFING,
    reservationId: 'res-1',
    ...o,
  }));
  const reservations =
    setup.reservation === null
      ? []
      : [
          {
            id: 'res-1',
            status: setup.reservation?.status ?? ReservationStatus.ACTIVE,
            itemType: reserve,
            itemId: 'spec-1',
            qty: D(setup.reservation?.qty ?? '121.2'),
            shortfallQty: D(setup.reservation?.shortfall ?? '0'),
            productionOrders: orders,
          },
        ];
  const tx = {
    $queryRaw: jest.fn((_sql: TemplateStringsArray, ids: string[]) =>
      Promise.resolve(ids.map((id) => ({ id }))),
    ),
    fiscalDocument: {
      findFirst: jest
        .fn()
        .mockResolvedValue(setup.document ? { docType: 'FACTURA', number: 'F001-1' } : null),
    },
    salesOrder: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'o-1',
        seq: 7,
        status: setup.orderStatus ?? 'IN_PRODUCTION',
        createdById: 'u-1',
        sellerId: 'u-1',
        notes: null,
      }),
      findUniqueOrThrow: jest.fn((args: { select: Record<string, unknown> }) =>
        Promise.resolve(
          'items' in args.select
            ? {
                status: setup.orderStatus ?? 'PARTIALLY_FULFILLED',
                items: [
                  {
                    id: 'i-1',
                    qty: D('4'),
                    product: { businessLine: { inventoryStrategy: 'STANDARD' } },
                  },
                ],
              }
            : { totalPen: D('519.20') },
        ),
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    salesOrderItem: {
      findFirst: jest.fn().mockResolvedValue(item),
      update: jest.fn().mockResolvedValue({ id: 'i-1' }),
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { subtotalPen: D('264'), igvPen: D('47.52') } }),
    },
    salesOrderItemPiece: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    reservation: {
      findMany: jest.fn().mockResolvedValue(reservations),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ id: 'res-1' }),
    },
    dispatchItem: {
      aggregate: jest.fn().mockResolvedValue({
        _sum: { qty: setup.dispatched === undefined ? null : D(setup.dispatched) },
      }),
      groupBy: jest
        .fn()
        .mockResolvedValue(
          setup.dispatched === undefined
            ? []
            : [{ salesOrderItemId: 'i-1', _sum: { qty: D(setup.dispatched) } }],
        ),
    },
    productionOrder: { findUniqueOrThrow: jest.fn().mockResolvedValue({ seq: 99 }) },
    productionOrderItem: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const orders$ = {
    findOne: jest.fn().mockResolvedValue({ id: 'o-1' }),
    createReservations: jest.fn().mockResolvedValue(undefined),
    reserveExtra: jest
      .fn()
      .mockResolvedValue({ reserved: new Decimal('36.36'), shortfall: new Decimal('0') }),
  };
  const roofing = { createFromReservationInTx: jest.fn().mockResolvedValue('op-new') };
  const prisma = { $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  const service = new SalesOrderEditsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    orders$ as unknown as SalesOrdersService,
    roofing as unknown as RoofingProductionService,
    {} as Env,
  );
  return { service, tx, audit, orders: orders$, roofing };
}

/** La línea que devolvería `resolveSalesLines` para la cantidad nueva. */
function line(qty: string, pieces: { lengthMm: string; qty: number }[], reserveQty: string) {
  (resolveSalesLines as jest.Mock).mockResolvedValue([
    {
      lineNumber: 1,
      description: 'COB',
      qty,
      subtotalPen: '264.0000',
      igvPen: '47.5200',
      totalPen: '311.5200',
      reserveItemType: InventoryItemType.RAW_MATERIAL,
      reserveItemId: 'spec-1',
      reserveQty,
      reserveUnit: 'KGM',
      pieces: pieces.map((p, i) => ({ lineNumber: i + 1, ...p })),
    },
  ]);
}

const p = (m: number, qty: number) => ({ lengthMm: (m * 1000).toFixed(2), qty });
const liveOp = (reported: { lengthMm: Prisma.Decimal; qty: number }[]): OrderFake => ({
  id: 'op-1',
  seq: 10,
  status: ProductionOrderStatus.IN_PROGRESS,
  items: [piece(6, 2), piece(4, 2)],
  reports: [{ metersM: null, piecesDetail: reported }],
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('cc45 — cambiar la cantidad con producción (camino nuevo)', () => {
  it('bajar a lo registrado: libera la reserva, el plan baja y la OP queda lista para cerrar', async () => {
    const { service, tx, audit } = build({ orders: [liveOp([piece(6, 2)])] });
    line('12.000', [p(6, 2)], '72.720');
    await service.updateItemQty(ADMIN, 'o-1', 'i-1', {
      qty: '12.000',
      pieces: [p(6, 2)],
      reason: 'El cliente redujo el pedido',
    });
    expect(tx.reservation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ReservationStatus.RELEASED, qty: '0' }),
      }),
    );
    expect(tx.productionOrderItem.createMany).toHaveBeenCalledWith({
      data: [{ productionOrderId: 'op-1', lineNumber: 1, lengthMm: '6000.00', qty: 2 }],
    });
    const calls = audit.write.mock.calls as unknown[][];
    const written = calls[0]?.[1] as { reason: string; after: unknown };
    expect(written.reason).toBe('El cliente redujo el pedido');
  });

  it('la vista previa dice lo mismo y no guarda: «lista para Registrar y cerrar»', async () => {
    const { service } = build({ orders: [liveOp([piece(6, 2)])] });
    line('12.000', [p(6, 2)], '72.720');
    const preview = await service.previewItemQty(ADMIN, 'o-1', 'i-1', {
      qty: '12.000',
      pieces: [p(6, 2)],
    });
    expect(preview.kind).toBe('PIECES');
    expect(preview.minQty).toBe('12.000');
    expect(preview.rows).toEqual([
      { lengthMm: '6000.00', ordered: 2, registered: 2 },
      { lengthMm: '4000.00', ordered: 2, registered: 0 },
    ]);
    expect(preview.outcome?.ok).toBe(true);
    const effects = preview.outcome?.effects.join(' ') ?? '';
    expect(effects).toContain('La línea queda en 12.000 m, 2 planchas: igual a lo registrado.');
    expect(effects).toContain('lista para «Registrar y cerrar»');
    expect(effects).toContain('Se libera');
    expect(effects).toContain('El total del pedido baja de S/ 519.20 a S/ 311.52');
  });

  it('subir con la OP viva: reserva lo nuevo por la puerta de confirmar y el plan crece', async () => {
    const { service, tx, orders } = build({
      orders: [liveOp([piece(6, 2)])],
      reservation: { status: ReservationStatus.ACTIVE, qty: '48.48' },
    });
    line('26.000', [p(6, 2), p(4, 2), p(3, 2)], '157.560');
    const preview = await service.previewItemQty(ADMIN, 'o-1', 'i-1', {
      qty: '26.000',
      pieces: [p(6, 2), p(4, 2), p(3, 2)],
    });
    const effects = preview.outcome?.effects.join(' ') ?? '';
    expect(effects).toContain('se agregan 2 planchas de 3.00 m');
    expect(effects).toContain('Se reserva 36.360 kg más de Bobina 0.40 mm Rojo: hay disponible.');
    // 26 − 12 registrados = 14 m × 6,06 = 84,84; reservados 48,48 ⇒ faltan 36,36.
    expect(orders.reserveExtra).toHaveBeenCalledWith(
      tx,
      ADMIN,
      'o-1',
      expect.objectContaining({ id: 'i-1' }),
      '36.360',
      { allowShortfall: true },
    );
  });

  it('subir sin material: con faltante confirmado, lo dice', async () => {
    const { service, orders } = build({
      orders: [liveOp([piece(6, 2)])],
      reservation: { status: ReservationStatus.ACTIVE, qty: '48.48' },
    });
    line('26.000', [p(6, 2), p(4, 2), p(3, 2)], '157.560');
    orders.reserveExtra.mockResolvedValueOnce({
      reserved: new Decimal('10'),
      shortfall: new Decimal('20'),
    });
    const preview = await service.previewItemQty(ADMIN, 'o-1', 'i-1', {
      qty: '26.000',
      pieces: [p(6, 2), p(4, 2), p(3, 2)],
    });
    expect(preview.outcome?.shortfallQty).toBe('20.000');
    expect(preview.outcome?.effects.join(' ')).toContain('faltan 20.000 kg');
  });

  it('pisos, motivo, permisos y la misma cantidad', async () => {
    const reported = [piece(6, 2)];
    let h = build({ orders: [liveOp(reported)] });
    line('10.000', [p(6, 1), p(4, 1)], '60.600');
    await expect(
      h.service.updateItemQty(ADMIN, 'o-1', 'i-1', {
        qty: '10.000',
        pieces: [p(6, 1), p(4, 1)],
        reason: 'El cliente redujo el pedido',
      }),
    ).rejects.toThrow('El largo 6.00 m no puede bajar de 2 planchas: ya están registradas');

    h = build({ orders: [liveOp(reported)] });
    line('12.000', [p(6, 2)], '72.720');
    await expect(
      h.service.updateItemQty(ADMIN, 'o-1', 'i-1', { qty: '12.000', pieces: [p(6, 2)] }),
    ).rejects.toThrow('el motivo es obligatorio');

    h = build({ orders: [liveOp(reported)] });
    await expect(
      h.service.updateItemQty(SELLER, 'o-1', 'i-1', {
        qty: '12.000',
        pieces: [p(6, 2)],
        reason: 'El cliente redujo el pedido',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    h = build({ orders: [liveOp(reported)] });
    line('20.000', [p(6, 2), p(4, 2)], '121.200');
    await expect(
      h.service.updateItemQty(ADMIN, 'o-1', 'i-1', {
        qty: '20.000',
        pieces: [p(6, 2), p(4, 2)],
        reason: 'Corrección',
      }),
    ).rejects.toThrow('la cantidad nueva es la misma de ahora');
  });

  it('con la OP cerrada: subir abre una OP por la diferencia; la vista previa no la crea', async () => {
    const closed: OrderFake = {
      id: 'op-1',
      seq: 10,
      status: ProductionOrderStatus.CLOSED,
      items: [piece(5, 2)],
      reports: [{ metersM: null, piecesDetail: [piece(5, 2)] }],
    };
    let h = build({
      qty: '10',
      pieces: [piece(5, 2)],
      orders: [closed],
      reservation: { status: ReservationStatus.RELEASED, qty: '0' },
    });
    line('16.000', [p(5, 2), p(2, 3)], '96.960');
    const preview = await h.service.previewItemQty(ADMIN, 'o-1', 'i-1', {
      qty: '16.000',
      pieces: [p(5, 2), p(2, 3)],
    });
    expect(preview.outcome?.effects.join(' ')).toContain(
      'Nace una orden nueva por la diferencia: 3 planchas, 6.000 m.',
    );
    expect(h.roofing.createFromReservationInTx).not.toHaveBeenCalled();

    h = build({
      qty: '10',
      pieces: [piece(5, 2)],
      orders: [closed],
      reservation: { status: ReservationStatus.RELEASED, qty: '0' },
    });
    await h.service.updateItemQty(ADMIN, 'o-1', 'i-1', {
      qty: '16.000',
      pieces: [p(5, 2), p(2, 3)],
      reason: 'El cliente amplió el pedido',
    });
    expect(h.roofing.createFromReservationInTx).toHaveBeenCalledWith(
      h.tx,
      ADMIN,
      expect.objectContaining({ reservationId: 'res-1', plan: [{ lengthMm: '2000.00', qty: 3 }] }),
    );
  });

  it('con la OP cerrada corta, bajar no reserva ni abre producción (segundo modelo P2-1)', async () => {
    const { service, orders, roofing } = build({
      qty: '20',
      orders: [
        {
          id: 'op-1',
          seq: 10,
          status: ProductionOrderStatus.CLOSED,
          items: [piece(6, 2)],
          reports: [{ metersM: null, piecesDetail: [piece(6, 2)] }],
        },
      ],
      reservation: { status: ReservationStatus.RELEASED, qty: '0' },
    });
    line('16.000', [p(6, 2), p(4, 1)], '96.960');
    await service.updateItemQty(ADMIN, 'o-1', 'i-1', {
      qty: '16.000',
      pieces: [p(6, 2), p(4, 1)],
      reason: 'El cliente redujo el pedido',
    });
    expect(orders.reserveExtra).not.toHaveBeenCalled();
    expect(roofing.createFromReservationInTx).not.toHaveBeenCalled();
  });

  it('una línea con OP de perfiles atada no pasa por este camino', async () => {
    const { service } = build({
      reserve: InventoryItemType.PRODUCT,
      unit: 'NIU',
      roofingKind: null,
      qty: '10',
      pieces: [],
      orders: [
        {
          id: 'op-1',
          seq: 12,
          status: ProductionOrderStatus.CLOSED,
          kind: ProductionOrderKind.DRYWALL,
          items: [],
          reports: [{ metersM: null, piecesDetail: [] }],
        },
      ],
    });
    await expect(
      service.updateItemQty(ADMIN, 'o-1', 'i-1', { qty: '12', reason: 'Corrección' }),
    ).rejects.toThrow('tiene la orden de perfiles OP-000012');
  });

  it('accesorio: el plan de la OP viva son los metros nuevos', async () => {
    const { service } = build({
      roofingKind: 'ACCESORIO',
      qty: '5',
      pieces: [],
      orders: [
        {
          id: 'op-1',
          seq: 10,
          status: ProductionOrderStatus.IN_PROGRESS,
          items: [],
          reports: [{ metersM: D('3'), piecesDetail: [] }],
        },
      ],
    });
    line('6.500', [], '39.390');
    const preview = await service.previewItemQty(ADMIN, 'o-1', 'i-1', { qty: '6.500' });
    expect(preview.kind).toBe('METERS');
    expect(preview.productionOrders[0]?.planMeters).toBe('5.000');
    expect(preview.outcome?.effects.join(' ')).toContain(
      'El plan de OP-000010 pasa de 5.000 m a 6.500 m.',
    );
  });

  it('plancha de catálogo: el piso y el plan van en planchas', async () => {
    const { service, tx } = build({
      unit: 'NIU',
      roofingKind: 'PLANCHA',
      lengthMm: D('2000'),
      qty: '10',
      pieces: [],
      orders: [
        {
          id: 'op-1',
          seq: 10,
          status: ProductionOrderStatus.IN_PROGRESS,
          items: [piece(2, 10)],
          reports: [{ metersM: null, piecesDetail: [piece(2, 4)] }],
        },
      ],
    });
    line('3.000', [], '36.360');
    await expect(
      service.updateItemQty(ADMIN, 'o-1', 'i-1', { qty: '3', reason: 'Corrección' }),
    ).rejects.toThrow(BadRequestException);
    line('4.000', [], '48.480');
    await service.updateItemQty(ADMIN, 'o-1', 'i-1', { qty: '4', reason: 'Corrección' });
    expect(tx.productionOrderItem.createMany).toHaveBeenCalledWith({
      data: [{ productionOrderId: 'op-1', lineNumber: 1, lengthMm: '2000.00', qty: 4 }],
    });
  });

  it('con despachos: bajar hasta lo despachado deja el pedido atendido', async () => {
    const { service, tx } = build({
      reserve: InventoryItemType.PRODUCT,
      unit: 'NIU',
      roofingKind: null,
      qty: '10',
      pieces: [],
      reservation: { status: ReservationStatus.ACTIVE, qty: '6' },
      dispatched: '4',
    });
    (resolveSalesLines as jest.Mock).mockResolvedValue([
      {
        lineNumber: 1,
        description: 'X',
        qty: '4.000',
        subtotalPen: '80.0000',
        igvPen: '14.4000',
        totalPen: '94.4000',
        reserveItemType: InventoryItemType.PRODUCT,
        reserveItemId: 'spec-1',
        reserveQty: '4.000',
        reserveUnit: 'NIU',
        pieces: [],
      },
    ]);
    await service.updateItemQty(ADMIN, 'o-1', 'i-1', { qty: '4', reason: 'Corrección' });
    expect(tx.salesOrder.update).toHaveBeenCalledWith({
      where: { id: 'o-1' },
      data: { status: 'FULFILLED' },
    });
    (resolveSalesLines as jest.Mock).mockResolvedValue([
      {
        lineNumber: 1,
        description: 'X',
        qty: '3.000',
        subtotalPen: '60.0000',
        igvPen: '10.8000',
        totalPen: '70.8000',
        reserveItemType: InventoryItemType.PRODUCT,
        reserveItemId: 'spec-1',
        reserveQty: '3.000',
        reserveUnit: 'NIU',
        pieces: [],
      },
    ]);
    await expect(
      service.updateItemQty(ADMIN, 'o-1', 'i-1', { qty: '3', reason: 'Corrección' }),
    ).rejects.toThrow('ya se despacharon');
  });

  it('la vista previa: comprobante y vendedor bloquean; un rechazo viaja como mensaje', async () => {
    let h = build({ document: true, orders: [liveOp([piece(6, 2)])] });
    let preview = await h.service.previewItemQty(ADMIN, 'o-1', 'i-1', { qty: '12.000' });
    expect(preview.blocked).toContain('comprobante');
    expect(preview.outcome).toBeNull();

    h = build({ orders: [liveOp([piece(6, 2)])] });
    preview = await h.service.previewItemQty(SELLER, 'o-1', 'i-1', {});
    expect(preview.adminOnly).toBe(true);
    expect(preview.blocked).toContain('solo un administrador');

    h = build({ orders: [liveOp([piece(6, 2)])] });
    line('10.000', [p(6, 1), p(4, 1)], '60.600');
    preview = await h.service.previewItemQty(ADMIN, 'o-1', 'i-1', {
      qty: '10.000',
      pieces: [p(6, 1), p(4, 1)],
    });
    expect(preview.outcome).toMatchObject({ ok: false });
    expect(preview.outcome?.message).toContain('no puede bajar de 2 planchas');
  });
});
