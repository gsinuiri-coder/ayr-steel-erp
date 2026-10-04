import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  InventoryItemType,
  InventoryStrategy,
  ReservationStatus,
  Role,
  SalesOrderStatus,
} from '@prisma/client';
import { confirmQuotationSchema, Decimal } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import { ENV, type Env } from '../config/env';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { RoofingProductionService } from '../production/roofing-production.service';
import type * as assignmentsModule from '../production/production-assignments';
import * as rawMaterialModule from './raw-material';
import type * as ledgerModule from './reserved-ledger';
import {
  consumeReservationQty,
  releaseRemainingReservation,
  restoreReservationQty,
} from './reservation-guard';
import { reduceReservation } from './reservation-transfer';
import { shortfallAudit, splitReservable, sumShortfalls } from './order-shortfall';
import { SalesOrdersService } from './sales-orders.service';

jest.mock('./raw-material', () => ({
  ...jest.requireActual<typeof rawMaterialModule>('./raw-material'),
  findRawMaterialSpecs: jest.fn(),
  rawMaterialCoilIds: jest.fn(),
  rawMaterialAvailability: jest.fn(),
  // D-386: sin agregados con promesas, el conjunto a bloquear son las bobinas nombradas.
  rawMaterialLockSet: jest.fn((_tx: unknown, ids: readonly string[]) => Promise.resolve([...ids])),
  rawMaterialSpecLabels: jest.fn(),
  assertRawMaterialInvariant: jest.fn(),
}));
jest.mock('./reserved-ledger', () => ({
  ...jest.requireActual<typeof ledgerModule>('./reserved-ledger'),
  sweepExpiredTemporaryReservations: jest.fn(),
}));
jest.mock('../production/production-assignments', () => ({
  ...jest.requireActual<typeof assignmentsModule>('../production/production-assignments'),
  assertStripsNotAssigned: jest.fn(),
}));

const findSpecsMock = jest.mocked(rawMaterialModule.findRawMaterialSpecs);
const coilIdsMock = jest.mocked(rawMaterialModule.rawMaterialCoilIds);
const availabilityMock = jest.mocked(rawMaterialModule.rawMaterialAvailability);
const labelsMock = jest.mocked(rawMaterialModule.rawMaterialSpecLabels);

const ADMIN = {
  id: 'admin-1',
  email: 'admin@ayr.test',
  name: 'Administrador',
  role: Role.ADMINISTRADOR,
  mustChangePassword: false,
  sessionId: 's-admin',
};
const SELLER = { ...ADMIN, id: 'seller-1', role: Role.VENDEDOR, sessionId: 's-seller' };

describe('D-341 — aritmética del faltante (pura)', () => {
  const d = (v: string) => new Decimal(v);

  describe('splitReservable', () => {
    it('alcanza: reserva todo y no falta nada', () => {
      const r = splitReservable(d('100'), d('150'));
      expect(r.reserve.toFixed(3)).toBe('100.000');
      expect(r.shortfall.toFixed(3)).toBe('0.000');
    });
    it('alcanza justo: no hay faltante', () => {
      const r = splitReservable(d('100'), d('100'));
      expect(r.shortfall.toFixed(3)).toBe('0.000');
    });
    it('no alcanza: reserva lo disponible y anota lo que falta', () => {
      const r = splitReservable(d('100'), d('60'));
      expect(r.reserve.toFixed(3)).toBe('60.000');
      expect(r.shortfall.toFixed(3)).toBe('40.000');
    });
    it('sin nada disponible: reserva cero y todo queda pendiente', () => {
      const r = splitReservable(d('100'), d('0'));
      expect(r.reserve.toFixed(3)).toBe('0.000');
      expect(r.shortfall.toFixed(3)).toBe('100.000');
    });
    it('disponible negativo (comprometido de más por otro documento) cuenta como cero, no como deuda', () => {
      const r = splitReservable(d('100'), d('-25'));
      expect(r.reserve.toFixed(3)).toBe('0.000');
      expect(r.shortfall.toFixed(3)).toBe('100.000');
    });
    it('la suma reservado + faltante siempre da lo pedido', () => {
      for (const [need, avail] of [
        ['37.5', '12.125'],
        ['0.001', '0'],
        ['999.999', '1000'],
      ] as const) {
        const r = splitReservable(d(need), d(avail));
        expect(r.reserve.plus(r.shortfall).toFixed(3)).toBe(d(need).toFixed(3));
      }
    });
  });

  describe('sumShortfalls', () => {
    const row = (over: Partial<Parameters<typeof sumShortfalls>[0][number]> = {}) => ({
      itemType: InventoryItemType.RAW_MATERIAL,
      itemId: 'spec-1',
      unit: 'KGM',
      shortfallQty: '40.000',
      status: ReservationStatus.ACTIVE,
      ...over,
    });
    const labelOf = (_t: InventoryItemType, id: string) =>
      ({ 'spec-1': '0.50 mm · ROJO', 'spec-2': '0.40 mm · AZUL' })[id];

    it('suma por espesor + color: dos líneas del mismo agregado son una sola fila', () => {
      const out = sumShortfalls([row(), row({ shortfallQty: '10.500' })], labelOf);
      expect(out).toEqual([{ label: '0.50 mm · ROJO', missingQty: '50.500', unit: 'KGM' }]);
    });
    it('agregados distintos van en filas distintas, ordenadas por etiqueta', () => {
      const out = sumShortfalls([row(), row({ itemId: 'spec-2', shortfallQty: '5' })], labelOf);
      expect(out.map((o) => o.label)).toEqual(['0.40 mm · AZUL', '0.50 mm · ROJO']);
    });
    it('una reserva liberada no aporta faltante: ya no promete nada', () => {
      expect(sumShortfalls([row({ status: ReservationStatus.RELEASED })], labelOf)).toEqual([]);
    });
    it('una reserva consumida SÍ lo aporta: la producción agotó lo reservado pero no tocó el faltante', () => {
      const out = sumShortfalls(
        [
          row({ status: ReservationStatus.CONSUMED, shortfallQty: '400.000' }),
          row({ status: ReservationStatus.RELEASED, shortfallQty: '999' }),
        ],
        labelOf,
      );
      expect(out).toEqual([{ label: '0.50 mm · ROJO', missingQty: '400.000', unit: 'KGM' }]);
    });
    it('faltante cero no genera fila', () => {
      expect(sumShortfalls([row({ shortfallQty: '0.000' })], labelOf)).toEqual([]);
    });
    it('sin etiqueta conocida usa el id, nunca queda vacío', () => {
      const out = sumShortfalls([row({ itemId: 'spec-x' })], labelOf);
      expect(out[0]?.label).toBe('spec-x');
    });
  });

  describe('shortfallAudit', () => {
    it('sin faltante no agrega nada al rastro', () => {
      expect(shortfallAudit([{ id: 'r1', shortfallQty: '0.000' }])).toEqual({});
    });
    it('con faltante lista solo las reservas que lo tienen', () => {
      expect(
        shortfallAudit([
          { id: 'r1', shortfallQty: '0' },
          { id: 'r2', shortfallQty: '12.5' },
        ]),
      ).toEqual({ shortfalls: [{ reservationId: 'r2', missingQty: '12.500' }] });
    });
  });
});

describe('D-341 — confirmQuotationSchema', () => {
  it('confirmar sin bandera no pide motivo (el flujo de siempre)', () => {
    expect(confirmQuotationSchema.safeParse({}).success).toBe(true);
    expect(confirmQuotationSchema.safeParse({ promisedDeliveryDate: '2026-10-01' }).success).toBe(
      true,
    );
  });
  it('confirmShortfall exige un motivo', () => {
    const r = confirmQuotationSchema.safeParse({ confirmShortfall: true });
    expect(r.success).toBe(false);
    expect(
      confirmQuotationSchema.safeParse({ confirmShortfall: true, shortfallReason: '   ' }).success,
    ).toBe(false);
    expect(
      confirmQuotationSchema.safeParse({ confirmShortfall: true, shortfallReason: 'abc' }).success,
    ).toBe(false);
  });
  it('confirmShortfall con motivo pasa, y el motivo se recorta', () => {
    const r = confirmQuotationSchema.parse({
      confirmShortfall: true,
      shortfallReason: '  Llega bobina el lunes  ',
    });
    expect(r.shortfallReason).toBe('Llega bobina el lunes');
  });
  it('confirmShortfall: false no obliga a nada', () => {
    expect(confirmQuotationSchema.safeParse({ confirmShortfall: false }).success).toBe(true);
  });
});

describe('D-341 — SalesOrdersService: confirmar con faltante', () => {
  let service: SalesOrdersService;
  let audit: { write: jest.Mock };
  let prisma: Record<string, unknown>;
  let upserts: { qty: string | { toString(): string }; shortfallQty: string }[];
  /** Lo que la última operación escribió en `audit_log` (segundo argumento de `audit.write`). */
  const auditEntry = (): unknown => (audit.write.mock.calls as unknown[][])[0]?.[1];

  const spec = { id: 'spec-1', businessLineId: 'bl-1', thicknessMm: '0.50', colorId: 'c-1' };

  function available(kg: string) {
    availabilityMock.mockResolvedValue({
      available: new Decimal(kg),
      physical: new Decimal('100'),
      reservedOnCoils: new Decimal(0),
      reservedGeneric: new Decimal('100').minus(new Decimal(kg)),
      mountedKg: new Decimal(0),
      mountedOrderCodes: [],
    } as unknown as Awaited<ReturnType<typeof rawMaterialModule.rawMaterialAvailability>>);
  }

  const rawLine = (over: Record<string, unknown> = {}) => ({
    id: 'item-1',
    lineNumber: 1,
    productId: 'p-1',
    reserveItemType: InventoryItemType.RAW_MATERIAL,
    reserveItemId: 'spec-1',
    reserveQty: '100.000',
    reserveUnit: 'KGM',
    ...over,
  });

  function txMock(extra: Record<string, unknown> = {}) {
    return {
      $queryRaw: jest.fn().mockResolvedValue([]),
      reservation: {
        upsert: jest.fn((args: { create: { qty: string; shortfallQty: string } }) => {
          upserts.push(args.create);
          return Promise.resolve({});
        }),
        ...((extra.reservation as object | undefined) ?? {}),
      },
      ...extra,
    };
  }

  beforeEach(async () => {
    upserts = [];
    audit = { write: jest.fn() };
    prisma = {};
    const moduleRef = await Test.createTestingModule({
      providers: [
        SalesOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: InventoryService, useValue: { lockAvailability: jest.fn() } },
        {
          provide: RoofingProductionService,
          useValue: { createFromReservationInTx: jest.fn().mockResolvedValue('op-1') },
        },
        { provide: ENV, useValue: {} as Env },
      ],
    }).compile();
    service = moduleRef.get(SalesOrdersService);
    // `confirm` de punta a punta: lo que no es del faltante (agregado, temporal, OP) se sustituye.
    jest
      .spyOn(
        service as unknown as { resolveRawMaterial: () => Promise<unknown> },
        'resolveRawMaterial',
      )
      .mockResolvedValue(new Map([[1, { specId: 'spec-1', kg: '100.000' }]]));
    jest.spyOn(service, 'endTemporaryInTx').mockResolvedValue(0);
    findSpecsMock.mockReset().mockResolvedValue(new Map([['spec-1', spec]]));
    coilIdsMock.mockReset().mockResolvedValue([]);
    availabilityMock.mockReset();
    labelsMock.mockReset().mockResolvedValue(new Map([['spec-1', '0.50 mm · ROJO']]));
  });

  it('un VENDEDOR con confirmShortfall recibe 403 sin tocar la base', async () => {
    const tx = jest.fn();
    (prisma as { $transaction: unknown }).$transaction = tx;
    await expect(
      service.confirm(SELLER, 'q-1', { confirmShortfall: true, shortfallReason: 'urgente' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx).not.toHaveBeenCalled();
  });

  it('sin la bandera, el faltante sigue rechazando (materia prima), igual que antes', async () => {
    available('60');
    const tx = txMock();
    await expect(
      service.createReservations(tx as never, ADMIN, 'o-1', [rawLine()]),
    ).rejects.toThrow(/tiene 60\.000 kg disponibles/);
    expect(upserts).toHaveLength(0);
  });

  it('con la bandera reserva lo disponible y guarda lo que falta', async () => {
    available('60');
    const tx = txMock();
    const shortfalls: never[] = [];
    await service.createReservations(tx as never, ADMIN, 'o-1', [rawLine()], {
      allowShortfall: true,
      shortfalls,
    });
    expect(upserts).toEqual([expect.objectContaining({ qty: '60.000', shortfallQty: '40.000' })]);
    expect(shortfalls).toEqual([
      {
        lineNumber: 1,
        label: '0.50 mm · ROJO',
        unit: 'KGM',
        promisedQty: '100.000',
        reservedQty: '60.000',
        missingQty: '40.000',
      },
    ]);
  });

  it('con disponible cero la reserva nace en cero y la OP puede nacer igual', async () => {
    available('0');
    const tx = txMock();
    await service.createReservations(tx as never, ADMIN, 'o-1', [rawLine()], {
      allowShortfall: true,
    });
    expect(upserts).toEqual([expect.objectContaining({ qty: '0.000', shortfallQty: '100.000' })]);
  });

  it('con la bandera pero material suficiente reserva todo y no deja faltante', async () => {
    available('500');
    const tx = txMock();
    const shortfalls: never[] = [];
    await service.createReservations(tx as never, ADMIN, 'o-1', [rawLine()], {
      allowShortfall: true,
      shortfalls,
    });
    expect(upserts).toEqual([expect.objectContaining({ qty: '100.000', shortfallQty: '0.000' })]);
    expect(shortfalls).toHaveLength(0);
  });

  it('una bobina entera sigue siendo todo o nada aunque haya bandera', async () => {
    const inventory = { lockAvailability: jest.fn() };
    inventory.lockAvailability.mockResolvedValue({
      available: new Decimal('0'),
      unit: 'KGM',
      qty: new Decimal('0'),
      reserved: new Decimal('0'),
    });
    (service as unknown as { inventory: unknown }).inventory = inventory;
    const tx = txMock({
      productBom: { findMany: jest.fn().mockResolvedValue([]) },
      coil: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'coil-1', code: 'BOB-1', status: 'OPEN', businessLineId: 'bl-1' },
          ]),
        findUnique: jest.fn().mockResolvedValue({ code: 'BOB-1' }),
      },
    });
    await expect(
      service.createReservations(
        tx as never,
        ADMIN,
        'o-1',
        [
          rawLine({
            reserveItemType: InventoryItemType.COIL,
            reserveItemId: 'coil-1',
            reserveQty: '500.000',
          }),
        ],
        { allowShortfall: true },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upserts).toHaveLength(0);
  });

  it('un producto de catálogo con stock sigue siendo todo o nada aunque haya bandera (el faltante es de la materia prima)', async () => {
    const inventory = {
      lockAvailability: jest.fn().mockResolvedValue({
        available: new Decimal('4'),
        unit: 'NIU',
        qty: new Decimal('4'),
        reserved: new Decimal('0'),
      }),
    };
    (service as unknown as { inventory: unknown }).inventory = inventory;
    const tx = txMock({
      product: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'prod-1',
            businessLineId: 'bl-1',
            businessLine: { inventoryStrategy: InventoryStrategy.STOCK },
          },
        ]),
        findUnique: jest.fn().mockResolvedValue({ sku: 'PERFIL-1' }),
      },
    });
    const shortfalls: never[] = [];
    await expect(
      service.createReservations(
        tx as never,
        ADMIN,
        'o-1',
        [
          rawLine({
            reserveItemType: InventoryItemType.PRODUCT,
            reserveItemId: 'prod-1',
            reserveQty: '10.000',
            reserveUnit: 'NIU',
          }),
        ],
        { allowShortfall: true, shortfalls },
      ),
    ).rejects.toThrow(/tiene 4\.000 NIU disponibles/);
    expect(upserts).toHaveLength(0);
    expect(shortfalls).toHaveLength(0);
  });

  it('un reintento no arrastra el faltante del intento anterior a la auditoría', async () => {
    // El servicio limpia `shortfalls` al empezar cada intento de la transacción.
    const attempts: number[] = [];
    (prisma as { $transaction: unknown }).$transaction = jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        attempts.push(1);
        await fn(makeConfirmTx());
        return 'o-1';
      },
    );
    jest.spyOn(service, 'findOne').mockResolvedValue({} as never);
    available('60');
    await service.confirm(ADMIN, 'q-1', {
      confirmShortfall: true,
      shortfallReason: 'llega el lunes',
    });
    const call = auditEntry() as {
      reason?: string;
      after: { shortfalls?: unknown[] };
    };
    expect(call.reason).toBe('llega el lunes');
    expect(call.after.shortfalls).toHaveLength(1);
  });

  it('confirmar con la bandera pero sin faltante real no registra motivo de excepción', async () => {
    (prisma as { $transaction: unknown }).$transaction = jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        await fn(makeConfirmTx());
        return 'o-1';
      },
    );
    jest.spyOn(service, 'findOne').mockResolvedValue({} as never);
    available('500');
    await service.confirm(ADMIN, 'q-1', {
      confirmShortfall: true,
      shortfallReason: 'por si acaso',
    });
    const call = auditEntry() as { reason?: string; after: object };
    expect(call.reason).toBeUndefined();
    expect(call.after).not.toHaveProperty('shortfalls');
  });

  /** Transacción mínima para recorrer `confirm` de punta a punta con una línea de materia prima. */
  function makeConfirmTx() {
    const items = [
      {
        id: 'item-1',
        lineNumber: 1,
        productId: 'p-1',
        reserveItemType: InventoryItemType.RAW_MATERIAL,
        reserveItemId: 'spec-1',
        reserveQty: '100.000',
        reserveUnit: 'KGM',
      },
    ];
    const quotationItem = {
      lineNumber: 1,
      productId: 'p-1',
      description: 'Techo',
      qty: new Decimal('10'),
      unit: 'MTR',
      listPricePen: new Decimal('1'),
      unitPricePen: new Decimal('1'),
      valuePerMeterPen: null,
      subtotalPen: new Decimal('1'),
      igvPen: new Decimal('0.18'),
      totalPen: new Decimal('1.18'),
      reserveItemType: InventoryItemType.RAW_MATERIAL,
      reserveItemId: 'spec-1',
      reserveQty: new Decimal('100'),
      reserveUnit: 'KGM',
      pieces: [],
    };
    return {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'q-1',
            seq: 1,
            status: 'EMITTED',
            valid_until: null,
            created_by_id: 'seller-1',
            seller_id: null,
          },
        ])
        .mockResolvedValue([]),
      quotation: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'q-1',
          customerId: 'cust-1',
          subtotalPen: new Decimal('1'),
          igvPen: new Decimal('0.18'),
          totalPen: new Decimal('1.18'),
          notes: null,
          sellerId: null,
          createdById: 'seller-1',
          items: [quotationItem],
        }),
        update: jest.fn(),
      },
      customer: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ isActive: true, name: 'ACME' }),
      },
      product: { findFirst: jest.fn().mockResolvedValue(null) },
      salesOrder: {
        create: jest
          .fn()
          .mockResolvedValue({ id: 'o-1', seq: 1, totalPen: new Decimal('1.18'), items }),
      },
      reservation: {
        upsert: jest.fn(() => Promise.resolve({})),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
  }

  describe('completeReservation', () => {
    function completeTx(over: Record<string, unknown> = {}, pendingRows?: object[]) {
      const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
      const pending = pendingRows ?? [
        {
          id: 'res-1',
          salesOrderItemId: 'item-1',
          itemType: InventoryItemType.RAW_MATERIAL,
          itemId: 'spec-1',
          unit: 'KGM',
          shortfallQty: new Decimal('40'),
          salesOrderItem: { lineNumber: 1, productId: 'p-1' },
        },
      ];
      const tx = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'o-1',
              seq: 1,
              status: SalesOrderStatus.CONFIRMED,
              origin: 'ERP',
              quotation_id: null,
              promised_delivery_date: null,
            },
          ])
          .mockResolvedValue([]),
        reservation: {
          findMany: jest
            .fn()
            .mockResolvedValueOnce(pending)
            .mockResolvedValue([{ id: 'res-1', shortfallQty: new Decimal('10') }]),
          update: jest.fn((args: { where: { id: string }; data: Record<string, unknown> }) => {
            updates.push(args);
            return Promise.resolve({});
          }),
        },
        ...over,
      };
      return { tx, updates };
    }

    beforeEach(() => {
      jest.spyOn(service, 'findOne').mockResolvedValue({} as never);
    });

    it('reserva lo que hoy alcanza, baja el faltante por lo mismo y audita', async () => {
      available('30');
      const { tx, updates } = completeTx();
      (prisma as { $transaction: unknown }).$transaction = jest.fn(
        (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      );
      await service.completeReservation(ADMIN, 'o-1', 'llegó bobina');
      expect(updates).toHaveLength(1);
      expect(updates[0]?.data).toEqual({
        qty: { increment: '30.000' },
        shortfallQty: '10.000',
        status: ReservationStatus.ACTIVE,
        consumedAt: null,
      });
      const entry = auditEntry() as {
        action: string;
        reason?: string;
        before: { shortfalls: unknown[] };
        after: { reservedNow: string };
      };
      expect(entry.action).toBe('sales.order.complete-reservation');
      expect(entry.reason).toBe('llegó bobina');
      expect(entry.before.shortfalls).toEqual([{ reservationId: 'res-1', missingQty: '40.000' }]);
      expect(entry.after.reservedNow).toBe('30.000');
    });

    it('si ya alcanza todo, el faltante queda en cero', async () => {
      available('500');
      const { tx, updates } = completeTx();
      (prisma as { $transaction: unknown }).$transaction = jest.fn(
        (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      );
      await service.completeReservation(ADMIN, 'o-1');
      expect(updates[0]?.data).toEqual({
        qty: { increment: '40.000' },
        shortfallQty: '0.000',
        status: ReservationStatus.ACTIVE,
        consumedAt: null,
      });
    });

    it('una reserva CONSUMIDA con faltante también se completa: pide las CONSUMIDAS y las revive', async () => {
      available('500');
      const { tx, updates } = completeTx();
      (prisma as { $transaction: unknown }).$transaction = jest.fn(
        (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      );
      await service.completeReservation(ADMIN, 'o-1');
      const where = (
        (tx.reservation.findMany.mock.calls as unknown[][])[0]?.[0] as {
          where: { status: { in: string[] } };
        }
      ).where;
      expect(where.status.in).toEqual([ReservationStatus.ACTIVE, ReservationStatus.CONSUMED]);
      // Al reservar algo, la fila vuelve a ACTIVA; sin nada reservado no se toca su estado.
      expect(updates[0]?.data).toMatchObject({
        status: ReservationStatus.ACTIVE,
        consumedAt: null,
      });
    });

    it('un pedido ya atendido no se completa', async () => {
      const { tx } = completeTx();
      tx.$queryRaw = jest.fn().mockResolvedValueOnce([
        {
          id: 'o-1',
          seq: 1,
          status: SalesOrderStatus.FULFILLED,
          origin: 'ERP',
          quotation_id: null,
          promised_delivery_date: null,
        },
      ]);
      (prisma as { $transaction: unknown }).$transaction = jest.fn(
        (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      );
      await expect(service.completeReservation(ADMIN, 'o-1')).rejects.toThrow(/ya está atendido/);
    });

    it('sin material nuevo disponible no cambia nada ni audita', async () => {
      available('0');
      const { tx } = completeTx();
      (prisma as { $transaction: unknown }).$transaction = jest.fn(
        (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      );
      await expect(service.completeReservation(ADMIN, 'o-1')).rejects.toThrow(
        /Todavía no hay material/,
      );
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('un pedido sin faltante no tiene nada que completar', async () => {
      const { tx } = completeTx({}, []);
      (prisma as { $transaction: unknown }).$transaction = jest.fn(
        (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      );
      await expect(service.completeReservation(ADMIN, 'o-1')).rejects.toThrow(/no tiene faltante/);
    });

    it('un pedido anulado no se completa', async () => {
      const { tx } = completeTx();
      tx.$queryRaw = jest.fn().mockResolvedValueOnce([
        {
          id: 'o-1',
          seq: 1,
          status: SalesOrderStatus.CANCELLED,
          origin: 'ERP',
          quotation_id: null,
          promised_delivery_date: null,
        },
      ]);
      (prisma as { $transaction: unknown }).$transaction = jest.fn(
        (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      );
      await expect(service.completeReservation(ADMIN, 'o-1')).rejects.toThrow(/anulado/);
    });
  });

  describe('confirmPreview: quién queda bloqueado por el faltante', () => {
    const note =
      'Línea 1: 0.50 mm · ROJO tiene 60.000 KGM disponibles y el pedido necesita 100.000 — faltan 40.000';

    function previewWith(result: { blockers?: string[]; shortfallNotes?: string[] }) {
      (prisma as { quotation: unknown }).quotation = {
        findUnique: jest.fn().mockResolvedValue({
          id: 'q-1',
          seq: 3,
          sellerId: SELLER.id,
          status: 'EMITTED',
          validUntil: null,
          customer: { name: 'ACME', isActive: true },
          items: [{ lineNumber: 1, product: { sku: 'TECHO', isActive: true } }],
        }),
      };
      (prisma as { quotationReservation: unknown }).quotationReservation = {
        findFirst: jest.fn().mockResolvedValue(null),
      };
      jest
        .spyOn(service as unknown as { previewLinesOf: () => Promise<unknown> }, 'previewLinesOf')
        .mockResolvedValue({ lines: [], blockers: [], shortfallNotes: [], ...result });
    }

    it('el ADMINISTRADOR puede confirmar pese al faltante: no bloquea y lo avisa aparte', async () => {
      previewWith({ shortfallNotes: [note] });
      const out = await service.confirmPreview(ADMIN, 'q-1');
      expect(out.blockers).toEqual([]);
      expect(out.shortfallNotes).toEqual([note]);
      expect(out.canConfirmWithShortfall).toBe(true);
    });

    it('el VENDEDOR sigue bloqueado por el faltante (D-054)', async () => {
      previewWith({ shortfallNotes: [note] });
      const out = await service.confirmPreview(SELLER, 'q-1');
      expect(out.blockers).toEqual([note]);
      expect(out.canConfirmWithShortfall).toBe(false);
    });

    it('sin faltante nadie queda bloqueado ni ve la opción de confirmar con faltante', async () => {
      previewWith({});
      for (const actor of [ADMIN, SELLER]) {
        const out = await service.confirmPreview(actor, 'q-1');
        expect(out.blockers).toEqual([]);
        expect(out.canConfirmWithShortfall).toBe(false);
      }
    });

    it('los demás bloqueos (bobina entera, catálogo) siguen bloqueando al ADMINISTRADOR', async () => {
      previewWith({ blockers: ['Línea 2: la bobina no alcanza'], shortfallNotes: [note] });
      const out = await service.confirmPreview(ADMIN, 'q-1');
      expect(out.blockers).toEqual(['Línea 2: la bobina no alcanza']);
    });
  });

  describe('transiciones que cierran el faltante: anular el pedido y liberar la reserva', () => {
    const activeReservation = {
      id: 'res-1',
      status: ReservationStatus.ACTIVE,
      shortfallQty: new Decimal('40'),
      productionOrders: [],
    };

    it('anular el pedido deja el faltante en cero y lo registra en la auditoría', async () => {
      jest.spyOn(service, 'findOne').mockResolvedValue({} as never);
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const tx = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'o-1',
              seq: 1,
              status: SalesOrderStatus.CONFIRMED,
              origin: 'ERP',
              quotation_id: null,
              promised_delivery_date: null,
            },
          ])
          .mockResolvedValue([]),
        reservation: { findMany: jest.fn().mockResolvedValue([activeReservation]), updateMany },
        salesOrder: { update: jest.fn() },
        // D-383: sin comprobantes, despachos ni producción que bloqueen la anulación.
        salesOrderItem: { findMany: jest.fn().mockResolvedValue([]) },
        fiscalDocument: { findMany: jest.fn().mockResolvedValue([]) },
        dispatch: { findMany: jest.fn().mockResolvedValue([]) },
        productionReport: { findMany: jest.fn().mockResolvedValue([]) },
      };
      (prisma as { $transaction: unknown }).$transaction = jest.fn(
        (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      );
      await service.cancel(ADMIN, 'o-1', { reason: 'el cliente desistió' });
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            qty: '0',
            shortfallQty: '0',
            status: ReservationStatus.RELEASED,
          }) as unknown,
        }),
      );
      const entry = auditEntry() as { before: { shortfalls: unknown[] } };
      expect(entry.before.shortfalls).toEqual([{ reservationId: 'res-1', missingQty: '40.000' }]);
    });

    it('anular también cierra el faltante de una reserva CONSUMIDA, y lo deja en la auditoría', async () => {
      jest.spyOn(service, 'findOne').mockResolvedValue({} as never);
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const consumed = {
        id: 'res-2',
        status: ReservationStatus.CONSUMED,
        shortfallQty: new Decimal('400'),
        productionOrders: [],
      };
      const tx = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'o-1',
              seq: 1,
              status: SalesOrderStatus.CONFIRMED,
              origin: 'ERP',
              quotation_id: null,
              promised_delivery_date: null,
            },
          ])
          .mockResolvedValue([]),
        reservation: { findMany: jest.fn().mockResolvedValue([consumed]), updateMany },
        salesOrder: { update: jest.fn() },
        // D-383: sin comprobantes, despachos ni producción que bloqueen la anulación.
        salesOrderItem: { findMany: jest.fn().mockResolvedValue([]) },
        fiscalDocument: { findMany: jest.fn().mockResolvedValue([]) },
        dispatch: { findMany: jest.fn().mockResolvedValue([]) },
        productionReport: { findMany: jest.fn().mockResolvedValue([]) },
      };
      (prisma as { $transaction: unknown }).$transaction = jest.fn(
        (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      );
      await service.cancel(ADMIN, 'o-1', { reason: 'el cliente desistió' });
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['res-2'] } },
        data: { shortfallQty: '0' },
      });
      const entry = auditEntry() as { before: { shortfalls: unknown[] } };
      expect(entry.before.shortfalls).toEqual([{ reservationId: 'res-2', missingQty: '400.000' }]);
    });

    it('anular un pedido sin faltante no agrega ruido a la auditoría', async () => {
      jest.spyOn(service, 'findOne').mockResolvedValue({} as never);
      const tx = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'o-1',
              seq: 1,
              status: SalesOrderStatus.CONFIRMED,
              origin: 'ERP',
              quotation_id: null,
              promised_delivery_date: null,
            },
          ])
          .mockResolvedValue([]),
        reservation: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ ...activeReservation, shortfallQty: new Decimal(0) }]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        salesOrder: { update: jest.fn() },
        // D-383: sin comprobantes, despachos ni producción que bloqueen la anulación.
        salesOrderItem: { findMany: jest.fn().mockResolvedValue([]) },
        fiscalDocument: { findMany: jest.fn().mockResolvedValue([]) },
        dispatch: { findMany: jest.fn().mockResolvedValue([]) },
        productionReport: { findMany: jest.fn().mockResolvedValue([]) },
      };
      (prisma as { $transaction: unknown }).$transaction = jest.fn(
        (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      );
      await service.cancel(ADMIN, 'o-1', { reason: 'error de carga' });
      const entry = auditEntry() as { before: object };
      expect(entry.before).not.toHaveProperty('shortfalls');
    });

    it('liberar la reserva deja el faltante en cero y guarda el valor anterior', async () => {
      jest
        .spyOn(service as unknown as { reserveLabels: () => Promise<unknown> }, 'reserveLabels')
        .mockResolvedValue(new Map());
      jest
        .spyOn(service as unknown as { toReservationDto: () => unknown }, 'toReservationDto')
        .mockReturnValue({});
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const tx = {
        reservation: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'res-1',
            status: ReservationStatus.ACTIVE,
            salesOrderId: 'o-1',
            shortfallQty: new Decimal('40'),
            itemType: InventoryItemType.RAW_MATERIAL,
            itemId: 'spec-1',
            qty: new Decimal('60'),
            unit: 'KGM',
            salesOrderItem: {
              lineNumber: 1,
              productId: 'p-1',
              qty: new Decimal('10'),
              unit: 'MTR',
              reserveItemType: InventoryItemType.RAW_MATERIAL,
              reserveItemId: 'spec-1',
            },
            productionOrders: [],
          }),
          updateMany,
        },
      };
      (prisma as { $transaction: unknown }).$transaction = jest.fn(
        (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      );
      (prisma as { reservation: unknown }).reservation = {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'res-1' }),
      };
      await service.releaseReservation(ADMIN, 'res-1', 'se vendió a otro cliente');
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ReservationStatus.RELEASED,
            shortfallQty: '0',
          }) as unknown,
        }),
      );
      const entry = auditEntry() as {
        before: { shortfallQty: string };
        after: { shortfallQty: string };
      };
      expect(entry.before.shortfallQty).toBe('40.000');
      expect(entry.after.shortfallQty).toBe('0.000');
    });
  });

  describe('la producción y el despacho no tocan el faltante', () => {
    const activeRow = { id: 'res-1', status: ReservationStatus.ACTIVE, qty: new Decimal('60') };
    function tx() {
      return {
        reservation: {
          findUnique: jest.fn().mockResolvedValue(activeRow),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
    }
    const writtenKeys = (t: ReturnType<typeof tx>) =>
      Object.keys(
        ((t.reservation.updateMany.mock.calls as unknown[][])[0]?.[0] as { data: object }).data,
      );

    it('consumir (reporte de OP o despacho), incluso hasta agotar la reserva', async () => {
      for (const consumed of ['20', '60', '90']) {
        const t = tx();
        await consumeReservationQty(t as never, 'res-1', new Decimal(consumed));
        expect(writtenKeys(t)).not.toContain('shortfallQty');
      }
    });

    it('liberar el sobrante al cerrar una orden', async () => {
      const t = tx();
      await releaseRemainingReservation(t as never, 'res-1');
      expect(writtenKeys(t)).not.toContain('shortfallQty');
    });

    it('trasladar la reserva al producto terminado (reduceReservation)', async () => {
      for (const reduced of ['20', '60']) {
        const t = tx();
        await reduceReservation(t as never, 'res-1', new Decimal(reduced), 'u-1');
        expect(writtenKeys(t)).not.toContain('shortfallQty');
      }
    });

    describe('restoreReservationQty: la reversa de una reserva parcial', () => {
      const consumedRow = (shortfall: string) => ({
        id: 'res-1',
        status: ReservationStatus.CONSUMED,
        qty: new Decimal('0'),
        shortfallQty: new Decimal(shortfall),
        salesOrderItem: { reserveQty: new Decimal('10') },
        salesOrder: { status: SalesOrderStatus.CONFIRMED },
      });
      const restore = async (shortfall: string, returned: string) => {
        const update = jest.fn();
        const t = {
          reservation: { findUnique: jest.fn().mockResolvedValue(consumedRow(shortfall)), update },
        };
        await restoreReservationQty(t as never, 'res-1', new Decimal(returned));
        return (update.mock.calls as unknown[][])[0]?.[0] as {
          data: { qty: string; status: string; consumedAt: null };
        };
      };

      it('no devuelve más de lo que la línea promete menos lo que nunca se reservó', async () => {
        // Línea de 10, faltante 4 (solo 6 reservados): el reporte sacó 8 y consumió 6.
        const call = await restore('4', '8');
        expect(call.data).toEqual({
          qty: '6.000',
          status: ReservationStatus.ACTIVE,
          consumedAt: null,
        });
      });

      it('con faltante, una reversa menor que el tope se restaura completa', async () => {
        expect((await restore('4', '5')).data.qty).toBe('5.000');
      });

      it('sin faltante no se topa: el comportamiento de siempre', async () => {
        expect((await restore('0', '8')).data.qty).toBe('8.000');
      });
    });
  });

  describe('findOrdersWithShortfall', () => {
    it('agrupa por pedido, suma por espesor + color y cuesta una consulta de reservas', async () => {
      const findMany = jest.fn().mockResolvedValue([
        {
          salesOrderId: 'o-1',
          itemType: InventoryItemType.RAW_MATERIAL,
          itemId: 'spec-1',
          unit: 'KGM',
          status: ReservationStatus.ACTIVE,
          shortfallQty: new Decimal('40'),
          salesOrder: { seq: 7, customer: { name: 'ACME' } },
        },
        {
          salesOrderId: 'o-1',
          itemType: InventoryItemType.RAW_MATERIAL,
          itemId: 'spec-1',
          unit: 'KGM',
          status: ReservationStatus.ACTIVE,
          shortfallQty: new Decimal('10'),
          salesOrder: { seq: 7, customer: { name: 'ACME' } },
        },
        {
          salesOrderId: 'o-2',
          itemType: InventoryItemType.RAW_MATERIAL,
          itemId: 'spec-1',
          unit: 'KGM',
          status: ReservationStatus.ACTIVE,
          shortfallQty: new Decimal('5'),
          salesOrder: { seq: 9, customer: { name: 'BETA' } },
        },
      ]);
      (prisma as { reservation: unknown }).reservation = { findMany };
      const out = await service.findOrdersWithShortfall();
      expect(findMany).toHaveBeenCalledTimes(1);
      const where = (
        (findMany.mock.calls as unknown[][])[0]?.[0] as { where: Record<string, unknown> }
      ).where;
      expect(where).toMatchObject({
        // La producción y el despacho agotan la reserva (CONSUMIDA) sin tocar el faltante.
        status: { in: [ReservationStatus.ACTIVE, ReservationStatus.CONSUMED] },
        shortfallQty: { gt: 0 },
        salesOrder: { status: { notIn: [SalesOrderStatus.CANCELLED, SalesOrderStatus.FULFILLED] } },
      });
      expect(out).toEqual([
        {
          orderId: 'o-1',
          orderCode: expect.stringContaining('7') as string,
          customerName: 'ACME',
          shortfalls: [{ label: '0.50 mm · ROJO', missingQty: '50.000', unit: 'KGM' }],
        },
        {
          orderId: 'o-2',
          orderCode: expect.stringContaining('9') as string,
          customerName: 'BETA',
          shortfalls: [{ label: '0.50 mm · ROJO', missingQty: '5.000', unit: 'KGM' }],
        },
      ]);
    });

    it('sin pedidos con faltante devuelve vacío sin más consultas', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      (prisma as { reservation: unknown }).reservation = { findMany };
      expect(await service.findOrdersWithShortfall()).toEqual([]);
      expect(labelsMock).not.toHaveBeenCalled();
    });
  });
});
