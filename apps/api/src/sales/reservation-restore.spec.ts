import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { InventoryItemType, ReservationStatus, Role, SalesOrderStatus } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import { ENV, type Env } from '../config/env';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { RoofingProductionService } from '../production/roofing-production.service';
import {
  fabricatedReleaseBlock,
  isFabricatedLineReservation,
  latestReleaseEvents,
  RESERVATION_RELEASE_ACTION,
  RESERVATION_RESTORE_ACTION,
  restorableByLine,
  restorableReservationIds,
  restoreBlock,
  restoreQty,
} from './reservation-restore';
import { upsertItemReservation } from './reservation-transfer';
import { SalesOrdersService } from './sales-orders.service';

/**
 * D-379: la reserva de producto terminado de una línea que se fabrica contra el pedido. El caso
 * real es FFA1-00001382 (PED-000011, línea 1, 48 m de COB040ROJO): la reserva se liberó a mano y
 * la línea quedó sin despacho posible (`docs/analisis/ffa1-1382-2026-10-01.md`).
 */

const ADMIN = {
  id: 'admin-1',
  email: 'admin@ayr.test',
  name: 'Administrador',
  role: Role.ADMINISTRADOR,
  mustChangePassword: false,
  sessionId: 's-admin',
};
const SELLER = { ...ADMIN, id: 'seller-1', role: Role.VENDEDOR, sessionId: 's-seller' };

/** La línea de una cobertura a medida: reservó materia prima y se fabrica contra el pedido. */
const ROOFING_LINE = {
  lineNumber: 1,
  productId: 'cob-rojo',
  qty: new Decimal('48'),
  unit: 'MTR',
  reserveItemType: InventoryItemType.RAW_MATERIAL,
  reserveItemId: 'spec-rojo',
};
/** Un perfil de stock: reservó su propio producto desde que se confirmó. */
const STOCK_LINE = {
  ...ROOFING_LINE,
  productId: 'perfil',
  unit: 'NIU',
  reserveItemType: InventoryItemType.PRODUCT,
  reserveItemId: 'perfil',
};

const productReservation = (over: Record<string, unknown> = {}) => ({
  id: 'res-prod',
  status: ReservationStatus.ACTIVE,
  itemType: InventoryItemType.PRODUCT,
  itemId: 'cob-rojo',
  qty: new Decimal('48'),
  unit: 'MTR',
  ...over,
});

describe('D-379 — reglas puras', () => {
  describe('isFabricatedLineReservation', () => {
    it('la reserva de producto de una cobertura a medida es la de lo fabricado', () => {
      expect(isFabricatedLineReservation(productReservation(), ROOFING_LINE)).toBe(true);
    });
    it('la de materia prima de esa misma línea, no', () => {
      expect(
        isFabricatedLineReservation(
          productReservation({ itemType: InventoryItemType.RAW_MATERIAL, itemId: 'spec-rojo' }),
          ROOFING_LINE,
        ),
      ).toBe(false);
    });
    it('un producto de stock reserva su propio producto desde el principio: no se fabrica', () => {
      expect(
        isFabricatedLineReservation(productReservation({ itemId: 'perfil' }), STOCK_LINE),
      ).toBe(false);
    });
  });

  describe('fabricatedReleaseBlock', () => {
    it('bloquea liberar lo fabricado sin despachar, con un mensaje que dice qué hacer', () => {
      const msg = fabricatedReleaseBlock(productReservation(), ROOFING_LINE);
      expect(msg).toContain('La línea 1 se fabrica contra el pedido');
      expect(msg).toContain('48.000 MTR ya fabricados');
      expect(msg).toContain('Despacha la línea, revierte la producción o anula el pedido');
    });
    it('no bloquea la materia prima ni un producto de stock', () => {
      expect(
        fabricatedReleaseBlock(
          productReservation({ itemType: InventoryItemType.RAW_MATERIAL, itemId: 'spec-rojo' }),
          ROOFING_LINE,
        ),
      ).toBeNull();
      expect(
        fabricatedReleaseBlock(productReservation({ itemId: 'perfil' }), STOCK_LINE),
      ).toBeNull();
    });
    it('sin cantidad pendiente no hay nada que proteger', () => {
      expect(
        fabricatedReleaseBlock(productReservation({ qty: new Decimal('0') }), ROOFING_LINE),
      ).toBeNull();
    });
  });

  describe('restoreBlock', () => {
    const candidate = (over: Record<string, unknown> = {}) => ({
      id: 'res-prod',
      status: ReservationStatus.RELEASED,
      itemType: InventoryItemType.PRODUCT,
      itemId: 'cob-rojo',
      qty: new Decimal('48'),
      salesOrder: { status: SalesOrderStatus.CONFIRMED },
      salesOrderItem: ROOFING_LINE,
      ...over,
    });
    it('una liberada a mano se restaura', () => {
      expect(restoreBlock(candidate(), RESERVATION_RELEASE_ACTION)).toBeNull();
    });
    it('no la de un producto de stock: D-379 es la reserva de lo fabricado', () => {
      expect(
        restoreBlock(
          candidate({ itemId: 'perfil', salesOrderItem: STOCK_LINE }),
          RESERVATION_RELEASE_ACTION,
        ),
      ).toContain('reserva de lo fabricado');
    });
    it('no si la línea cambió de producto después de liberarla', () => {
      expect(
        restoreBlock(
          candidate({ salesOrderItem: { ...ROOFING_LINE, productId: 'cob-azul' } }),
          RESERVATION_RELEASE_ACTION,
        ),
      ).toContain('ya no vende ese producto');
    });
    it('no si el pedido está anulado (la liberó la anulación)', () => {
      expect(
        restoreBlock(
          candidate({ salesOrder: { status: SalesOrderStatus.CANCELLED }, qty: new Decimal('0') }),
          null,
        ),
      ).toContain('anulado');
    });
    it('no si el pedido ya está atendido', () => {
      expect(
        restoreBlock(candidate({ salesOrder: { status: SalesOrderStatus.FULFILLED } }), null),
      ).toContain('atendido');
    });
    it('no si la cerró un despacho (CONSUMED)', () => {
      expect(
        restoreBlock(candidate({ status: ReservationStatus.CONSUMED }), RESERVATION_RELEASE_ACTION),
      ).toContain('despacho');
    });
    it('no si ya está activa', () => {
      expect(restoreBlock(candidate({ status: ReservationStatus.ACTIVE }), null)).toContain(
        'ya está activa',
      );
    });
    it('no si no es de producto terminado', () => {
      expect(
        restoreBlock(
          candidate({ itemType: InventoryItemType.RAW_MATERIAL }),
          RESERVATION_RELEASE_ACTION,
        ),
      ).toContain('producto terminado');
    });
    it('no si la cerró otra operación: cantidad en cero o sin liberación manual', () => {
      // Revertir producción la deja en cero; su último evento puede seguir siendo una liberación
      // manual vieja, y aun así no se restaura.
      expect(
        restoreBlock(candidate({ qty: new Decimal('0') }), RESERVATION_RELEASE_ACTION),
      ).toContain('liberada a mano');
      // Ya se restauró una vez y nadie la volvió a liberar a mano.
      expect(restoreBlock(candidate(), RESERVATION_RESTORE_ACTION)).toContain('liberada a mano');
      expect(restoreBlock(candidate(), null)).toContain('liberada a mano');
    });
  });

  describe('restoreQty', () => {
    it('vuelve a prometer lo que prometía, sin pasar de lo que queda por despachar', () => {
      expect(
        restoreQty({
          reservationQty: '48',
          reservationUnit: 'MTR',
          line: ROOFING_LINE,
          dispatchedOnItem: new Decimal(0),
          fabricated: new Decimal('48'),
        }).toFixed(3),
      ).toBe('48.000');
      expect(
        restoreQty({
          reservationQty: '48',
          reservationUnit: 'MTR',
          line: ROOFING_LINE,
          dispatchedOnItem: new Decimal('30'),
          fabricated: new Decimal('48'),
        }).toFixed(3),
      ).toBe('18.000');
    });
    it('nunca negativo, y con otra unidad manda lo que prometía la reserva', () => {
      expect(
        restoreQty({
          reservationQty: '48',
          reservationUnit: 'MTR',
          line: ROOFING_LINE,
          dispatchedOnItem: new Decimal('60'),
          fabricated: new Decimal('100'),
        }).toFixed(3),
      ).toBe('0.000');
      expect(
        restoreQty({
          reservationQty: '12',
          reservationUnit: 'KGM',
          line: ROOFING_LINE,
          dispatchedOnItem: new Decimal('60'),
          fabricated: new Decimal('100'),
        }).toFixed(3),
      ).toBe('12.000');
    });
  });

  describe('latestReleaseEvents y restorableReservationIds', () => {
    const db = (rows: object[]) => ({ auditLog: { findMany: jest.fn().mockResolvedValue(rows) } });

    it('toma el evento más reciente de cada reserva, con el motivo de la liberación', async () => {
      const at = new Date('2026-09-29T08:03:12Z');
      const out = await latestReleaseEvents(
        db([
          {
            entityId: 'a',
            action: RESERVATION_RELEASE_ACTION,
            at,
            after: { reason: 'mala rerva' },
          },
          { entityId: 'a', action: RESERVATION_RESTORE_ACTION, at: new Date(0), after: {} },
        ]) as never,
        ['a'],
      );
      expect(out.get('a')).toEqual({
        action: RESERVATION_RELEASE_ACTION,
        at,
        reason: 'mala rerva',
      });
    });

    it('sin ids no consulta', async () => {
      const client = db([]);
      expect((await latestReleaseEvents(client as never, [])).size).toBe(0);
      expect(client.auditLog.findMany).not.toHaveBeenCalled();
    });

    it('solo las liberadas a mano, de producto, con cantidad y de un pedido vivo', async () => {
      const base = {
        status: ReservationStatus.RELEASED,
        itemType: InventoryItemType.PRODUCT,
        itemId: 'cob-rojo',
        qty: new Decimal('48'),
        salesOrder: { status: SalesOrderStatus.CONFIRMED },
        salesOrderItem: ROOFING_LINE,
      };
      const ids = await restorableReservationIds(
        db([
          { entityId: 'manual', action: RESERVATION_RELEASE_ACTION, at: new Date(), after: {} },
          { entityId: 'cancelled', action: RESERVATION_RELEASE_ACTION, at: new Date(), after: {} },
        ]) as never,
        [
          { id: 'manual', ...base },
          { id: 'zero', ...base, qty: new Decimal('0') },
          { id: 'cancelled', ...base, salesOrder: { status: SalesOrderStatus.CANCELLED } },
          { id: 'active', ...base, status: ReservationStatus.ACTIVE },
          { id: 'no-audit', ...base },
        ],
      );
      expect([...ids]).toEqual(['manual']);
    });

    it('restorableByLine enlaza solo la reserva de lo fabricado de cada línea', async () => {
      const client = {
        reservation: {
          findMany: jest.fn().mockResolvedValue([
            {
              ...productReservation({ status: ReservationStatus.RELEASED }),
              salesOrderId: 'o-11',
              salesOrderItemId: 'line-1',
              salesOrder: { status: SalesOrderStatus.CONFIRMED },
              salesOrderItem: ROOFING_LINE,
            },
            {
              ...productReservation({
                id: 'res-stock',
                status: ReservationStatus.RELEASED,
                itemId: 'perfil',
              }),
              salesOrderId: 'o-11',
              salesOrderItemId: 'line-2',
              salesOrder: { status: SalesOrderStatus.CONFIRMED },
              salesOrderItem: STOCK_LINE,
            },
          ]),
        },
        auditLog: {
          findMany: jest.fn().mockResolvedValue([
            { entityId: 'res-prod', action: RESERVATION_RELEASE_ACTION, at: new Date(), after: {} },
            {
              entityId: 'res-stock',
              action: RESERVATION_RELEASE_ACTION,
              at: new Date(),
              after: {},
            },
          ]),
        },
      };
      const out = await restorableByLine(client as never, ['line-1', 'line-2']);
      expect([...out]).toEqual([['line-1', { salesOrderId: 'o-11', reservationId: 'res-prod' }]]);
    });
  });
});

describe('D-379 — SalesOrdersService', () => {
  let service: SalesOrdersService;
  let prisma: Record<string, unknown>;
  let audit: { write: jest.Mock };
  let lockAvailability: jest.Mock;

  beforeEach(async () => {
    audit = { write: jest.fn() };
    prisma = {};
    lockAvailability = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SalesOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: InventoryService, useValue: { lockAvailability } },
        { provide: RoofingProductionService, useValue: {} },
        { provide: ENV, useValue: {} as Env },
      ],
    }).compile();
    service = moduleRef.get(SalesOrdersService);
    jest
      .spyOn(service as unknown as { reservationDto: () => Promise<unknown> }, 'reservationDto')
      .mockResolvedValue({ id: 'res-prod' });
  });

  function useTx(tx: object): void {
    prisma.$transaction = jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx));
  }

  /** cc30: la puerta (`lockDocuments`) pasa los ids y recibe las filas que bloqueó. */
  const lockGate = () =>
    jest.fn((_sql: TemplateStringsArray, ...values: unknown[]) =>
      Promise.resolve(
        Array.isArray(values[0]) ? (values[0] as string[]).map((id) => ({ id })) : [],
      ),
    );

  describe('releaseReservation', () => {
    it('no libera a mano lo fabricado sin despachar de una línea contra pedido', async () => {
      const updateMany = jest.fn();
      useTx({
        $queryRaw: lockGate(),
        reservation: {
          findUnique: jest.fn().mockResolvedValue({
            ...productReservation(),
            salesOrderId: 'o-11',
            shortfallQty: new Decimal('0'),
            salesOrderItem: ROOFING_LINE,
            productionOrders: [],
          }),
          updateMany,
        },
      });
      await expect(service.releaseReservation(ADMIN, 'res-prod', 'mala rerva')).rejects.toThrow(
        /se fabrica contra el pedido/,
      );
      expect(updateMany).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('la de un producto de stock se sigue liberando como siempre', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      useTx({
        $queryRaw: lockGate(),
        reservation: {
          findUnique: jest.fn().mockResolvedValue({
            ...productReservation({ itemId: 'perfil', unit: 'NIU' }),
            salesOrderId: 'o-11',
            shortfallQty: new Decimal('0'),
            salesOrderItem: STOCK_LINE,
            productionOrders: [],
          }),
          updateMany,
        },
      });
      await service.releaseReservation(ADMIN, 'res-prod', 'se vendió a otro');
      expect(updateMany).toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: RESERVATION_RELEASE_ACTION }),
      );
    });
  });

  describe('restoreReservation', () => {
    const released = {
      ...productReservation({ status: ReservationStatus.RELEASED }),
      releasedAt: new Date('2026-09-29T08:03:12Z'),
      releasedById: 'owner',
      salesOrderItemId: 'line-1',
      salesOrderItem: ROOFING_LINE,
    };

    function restoreTx(
      over: {
        reservation?: object;
        orderStatus?: SalesOrderStatus;
        lastAction?: string | null;
        dispatched?: string;
        updated?: number;
        /** Lo fabricado vivo de la línea (ingresos de producción no revertidos). */
        fabricated?: string;
      } = {},
    ) {
      const updateMany = jest.fn().mockResolvedValue({ count: over.updated ?? 1 });
      const tx = {
        $queryRaw: lockGate(),
        // cc30: la cabecera que `lockOrder` lee después de bloquear el pedido por la puerta.
        salesOrder: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'o-11',
            seq: 11,
            status: over.orderStatus ?? SalesOrderStatus.CONFIRMED,
            origin: 'CREATED_HERE',
            quotationId: null,
            promisedDeliveryDate: null,
          }),
        },
        reservation: {
          findUnique: jest.fn().mockResolvedValue({ salesOrderId: 'o-11' }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ ...released, ...over.reservation }),
          updateMany,
        },
        auditLog: {
          findMany: jest.fn().mockResolvedValue(
            over.lastAction === null
              ? []
              : [
                  {
                    entityId: 'res-prod',
                    action: over.lastAction ?? RESERVATION_RELEASE_ACTION,
                    at: new Date('2026-09-29T08:03:12Z'),
                    after: { reason: 'mala rerva' },
                  },
                ],
          ),
        },
        dispatchItem: {
          aggregate: jest.fn().mockResolvedValue({
            _sum: {
              reserveQty: over.dispatched === undefined ? null : new Decimal(over.dispatched),
            },
          }),
        },
        product: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ sku: 'COB040ROJO', businessLineId: 'roofing' }),
        },
        productionReport: { findMany: jest.fn().mockResolvedValue([{ id: 'rep-1' }]) },
        inventoryMovement: {
          findMany: jest
            .fn()
            .mockResolvedValue(
              over.fabricated === '0' ? [] : [{ qty: new Decimal(over.fabricated ?? '48') }],
            ),
        },
      };
      useTx(tx);
      return { tx, updateMany };
    }

    const available = (qty: string, reserved: string) =>
      lockAvailability.mockResolvedValue({
        qty: new Decimal(qty),
        reserved: new Decimal(reserved),
        available: new Decimal(qty).minus(new Decimal(reserved)),
        unit: 'MTR',
      });

    it('restaura la reserva liberada a mano: 48 m vuelven a ACTIVA, auditado con la liberación', async () => {
      const { updateMany } = restoreTx();
      available('348', '300');
      await service.restoreReservation(ADMIN, 'res-prod', 'D-379: reponer la reserva del 1382');
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'res-prod', status: ReservationStatus.RELEASED },
        data: {
          status: ReservationStatus.ACTIVE,
          qty: '48.000',
          releasedAt: null,
          releasedById: null,
        },
      });
      expect(lockAvailability).toHaveBeenCalledWith(expect.anything(), {
        businessLineId: 'roofing',
        itemType: InventoryItemType.PRODUCT,
        itemId: 'cob-rojo',
        unit: 'MTR',
      });
      const [, entry] = audit.write.mock.calls[0] as [
        unknown,
        {
          action: string;
          reason: string;
          before: Record<string, unknown>;
          after: Record<string, unknown>;
        },
      ];
      expect(entry.action).toBe(RESERVATION_RESTORE_ACTION);
      expect(entry.reason).toBe('D-379: reponer la reserva del 1382');
      // Los campos de la liberación que la fila vacía quedan en la auditoría.
      expect(entry.before).toEqual({
        status: ReservationStatus.RELEASED,
        qty: '48.000',
        releasedAt: '2026-09-29T08:03:12.000Z',
        releasedById: 'owner',
        releaseReason: 'mala rerva',
      });
      expect(entry.after).toMatchObject({
        status: 'ACTIVE',
        qty: '48.000',
        salesOrder: 'PED-000011',
      });
    });

    it('un no administrador recibe 403 sin abrir la transacción', async () => {
      const { tx } = restoreTx();
      await expect(service.restoreReservation(SELLER, 'res-prod', 'x')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(tx.reservation.findUnique).not.toHaveBeenCalled();
    });

    it('sin disponible rechaza con el faltante y no escribe nada', async () => {
      const { updateMany } = restoreTx();
      available('348', '320'); // quedan 28 libres
      await expect(service.restoreReservation(ADMIN, 'res-prod', 'x')).rejects.toThrow(
        /tiene 28\.000 MTR disponibles .* faltan 20\.000/,
      );
      expect(updateMany).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('no restaura una reserva cerrada por despacho', async () => {
      const { updateMany } = restoreTx({ reservation: { status: ReservationStatus.CONSUMED } });
      await expect(service.restoreReservation(ADMIN, 'res-prod', 'x')).rejects.toThrow(/despacho/);
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('no restaura la de un pedido anulado', async () => {
      const { updateMany } = restoreTx({
        orderStatus: SalesOrderStatus.CANCELLED,
        reservation: { qty: new Decimal('0') },
      });
      await expect(service.restoreReservation(ADMIN, 'res-prod', 'x')).rejects.toThrow(/anulado/);
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('autorrevisión P1-1: liberada y después revertida la producción, restaura solo lo que quedó', async () => {
      const { updateMany } = restoreTx({ fabricated: '18' });
      available('348', '300');
      await service.restoreReservation(ADMIN, 'res-prod', 'x');
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ qty: '18.000' }) as unknown }),
      );
    });

    it('revertida entera la producción, no hay nada fabricado que restaurar', async () => {
      const { updateMany } = restoreTx({ fabricated: '0' });
      await expect(service.restoreReservation(ADMIN, 'res-prod', 'x')).rejects.toThrow(
        /no le queda nada fabricado sin despachar/,
      );
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('no restaura una que no se liberó a mano', async () => {
      restoreTx({ lastAction: null });
      await expect(service.restoreReservation(ADMIN, 'res-prod', 'x')).rejects.toThrow(
        /liberada a mano/,
      );
    });

    it('si ya no queda nada por despachar en la línea, no hay reserva que restaurar', async () => {
      restoreTx({ dispatched: '48' });
      await expect(service.restoreReservation(ADMIN, 'res-prod', 'x')).rejects.toThrow(
        /no le queda nada fabricado sin despachar/,
      );
    });

    it('concurrencia: si la fila cambió entre el chequeo y la escritura, 409 sin auditoría', async () => {
      restoreTx({ updated: 0 });
      available('348', '300');
      await expect(service.restoreReservation(ADMIN, 'res-prod', 'x')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('toma los locks en orden: pedido, fila de la reserva, saldo', async () => {
      const { tx } = restoreTx();
      available('348', '300');
      await service.restoreReservation(ADMIN, 'res-prod', 'x');
      const calls = tx.$queryRaw.mock.calls as unknown as [TemplateStringsArray, string[]][];
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[0].join('?')).toContain('"sales_orders"');
      expect(calls[0]?.[1]).toEqual(['o-11']);
      expect(calls[1]?.[0].join('?')).toContain('"reservations"');
      expect(calls[1]?.[1]).toEqual(['res-prod']);
      expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
        lockAvailability.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it('un BadRequest del bloqueo llega como 400', async () => {
      restoreTx({ reservation: { status: ReservationStatus.ACTIVE } });
      await expect(service.restoreReservation(ADMIN, 'res-prod', 'x')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});

describe('D-379 — upsertItemReservation no suma la cantidad de una fila liberada', () => {
  function tx(existing: object | null) {
    return {
      reservation: {
        findUnique: jest.fn().mockResolvedValue(existing),
        create: jest.fn().mockResolvedValue({ id: 'nueva' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
  }
  const input = {
    salesOrderId: 'o-11',
    salesOrderItemId: 'line-1',
    itemType: InventoryItemType.PRODUCT,
    itemId: 'cob-rojo',
    qty: new Decimal('48'),
    unit: 'MTR',
    actorId: 'admin-1',
  };

  it('una liberada a mano con 48 m vuelve con lo producido ahora, no con 96', async () => {
    const client = tx({
      id: 'res-prod',
      qty: new Decimal('48'),
      status: ReservationStatus.RELEASED,
    });
    await upsertItemReservation(client as never, input);
    expect(client.reservation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          qty: '48.000',
          status: ReservationStatus.ACTIVE,
        }) as unknown,
      }),
    );
  });

  it('una activa sigue sumando, como antes', async () => {
    const client = tx({ id: 'res-prod', qty: new Decimal('20'), status: ReservationStatus.ACTIVE });
    await upsertItemReservation(client as never, input);
    expect(client.reservation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ qty: '68.000' }) as unknown }),
    );
  });
});
