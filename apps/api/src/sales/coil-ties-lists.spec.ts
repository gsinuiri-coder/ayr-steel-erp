import { Prisma, ReservationStatus, Role } from '@prisma/client';
import type { RequestUser } from '../auth/auth.types';
import { SalesOrdersService } from './sales-orders.service';

/**
 * D-310/D-311 en el servicio: `sellable-coils` y su lista de «no se ofrecen» aplican la misma
 * atadura que el pool, y `findReservations` nombra el despacho que consumió una reserva.
 */

jest.mock('./reserved-ledger', () => ({
  ...jest.requireActual<object>('./reserved-ledger'),
  reservedByItem: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('./price-floor', () => ({
  ...jest.requireActual<object>('./price-floor'),
  computePriceFloors: jest.fn().mockResolvedValue(new Map()),
}));

const D = (v: string) => new Prisma.Decimal(v);
const COIL_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN = { id: 'a-1', role: Role.ADMINISTRADOR } as RequestUser;
const ANA = { id: 'v-2', role: Role.VENDEDOR } as RequestUser;

interface Fixture {
  ties?: { reserveItemId: string; quotation: { seq: number; sellerId: string | null } }[];
  mounted?: boolean;
  balance?: string;
}

function serviceWith(f: Fixture = {}) {
  const coil = {
    id: COIL_ID,
    code: 'SALDO-AZUL-4194',
    typeKey: null,
    widthMm: D('1200'),
    thicknessMm: D('0.38'),
    status: 'OPEN',
    businessLineId: 'bl-1',
    businessLine: { code: 'ROOFING' },
    finish: { code: 'ALZ-AZUL-5002', name: 'Aluzinc azul' },
    color: { code: 'AZUL', name: 'AZUL' },
  };
  const quotationItemFind = jest.fn().mockResolvedValue(f.ties ?? []);
  const prisma = {
    coil: { findMany: jest.fn().mockResolvedValue([coil]) },
    inventoryBalance: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ itemId: COIL_ID, qty: D(f.balance ?? '100'), avgCost: D('5') }]),
    },
    productionOrderConsumption: {
      findMany: jest.fn().mockResolvedValue(f.mounted ? [{ coilId: COIL_ID }] : []),
    },
    quotationItem: { findMany: quotationItemFind },
    reservation: { findMany: jest.fn().mockResolvedValue([]) },
    quotationReservation: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = Object.create(SalesOrdersService.prototype) as SalesOrdersService;
  Object.assign(service, { prisma, env: { ROOFING_TOLERANCE_MM: '0.5' } });
  return { service, prisma, quotationItemFind };
}

describe('findSellableCoils — D-310', () => {
  it('una bobina libre se ofrece con su saldo', async () => {
    const { service } = serviceWith();
    const out = await service.findSellableCoils(ADMIN, {});
    expect(out.map((c) => c.coilId)).toEqual([COIL_ID]);
    expect(out[0]?.availableQty).toBe('100.000');
  });

  it('una bobina atada a otra cotización abierta no se ofrece', async () => {
    const { service } = serviceWith({
      ties: [{ reserveItemId: COIL_ID, quotation: { seq: 2, sellerId: 'v-1' } }],
    });
    expect(await service.findSellableCoils(ADMIN, {})).toEqual([]);
  });

  it('la cotización que se edita no cuenta su propia atadura', async () => {
    const { service, quotationItemFind } = serviceWith();
    await service.findSellableCoils(ADMIN, { excludeQuotationId: 'q-1' });
    const args = quotationItemFind.mock.calls[0] as [
      { where: { quotation: { id: { notIn: string[] } } } },
    ];
    expect(args[0].where.quotation.id).toEqual({ notIn: ['q-1'] });
  });
});

describe('findUnavailableSellableCoils — D-310', () => {
  const tie = { reserveItemId: COIL_ID, quotation: { seq: 2, sellerId: 'v-1' } };

  it('una bobina libre y sin atadura no aparece', async () => {
    const { service } = serviceWith();
    expect(await service.findUnavailableSellableCoils(ADMIN, {})).toEqual([]);
  });

  it('atada a otra cotización: aparece con «atada a COT-…»', async () => {
    const { service } = serviceWith({ ties: [tie] });
    const out = await service.findUnavailableSellableCoils(ADMIN, {});
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ coilId: COIL_ID, reason: 'atada a COT-000002' });
  });

  it('a un VENDEDOR no se le nombra la cotización de otro vendedor', async () => {
    const { service } = serviceWith({ ties: [tie] });
    const out = await service.findUnavailableSellableCoils(ANA, {});
    expect(out[0]?.reason).toBe('no disponible');
  });

  it('montada en una OP manda sobre la atadura', async () => {
    const { service } = serviceWith({ ties: [tie], mounted: true });
    const out = await service.findUnavailableSellableCoils(ADMIN, {});
    expect(out[0]?.reason).toBe('montada en una OP');
  });

  it('sin saldo no aparece aunque esté atada', async () => {
    const { service } = serviceWith({ ties: [tie], balance: '0' });
    expect(await service.findUnavailableSellableCoils(ADMIN, {})).toEqual([]);
  });
});

describe('findReservations — D-311', () => {
  function reservationRow(status: ReservationStatus) {
    return {
      id: 'r-1',
      salesOrderId: 'o-1',
      salesOrderItemId: 'i-1',
      itemType: 'COIL',
      itemId: COIL_ID,
      qty: D('0'),
      unit: 'KGM',
      status,
      createdAt: new Date('2026-09-20T10:00:00Z'),
      consumedAt: new Date('2026-09-21T10:00:00Z'),
      releasedAt: null,
      salesOrder: { seq: 28, customer: { name: 'Cliente' }, items: [{ productId: 'p-1' }] },
      productionOrders: [],
    };
  }

  function withReservations(status: ReservationStatus, dispatchSeq: number | null) {
    const { service, prisma } = serviceWith();
    Object.assign(prisma, {
      reservation: {
        findMany: jest.fn().mockResolvedValue([reservationRow(status)]),
      },
      dispatchItem: {
        findMany: jest.fn().mockResolvedValue(
          dispatchSeq === null
            ? []
            : [
                {
                  salesOrderItemId: 'i-1',
                  itemType: 'COIL',
                  itemId: COIL_ID,
                  dispatch: { id: 'd-9', seq: dispatchSeq },
                },
              ],
        ),
      },
    });
    return service;
  }

  it('una reserva consumida por una entrega trae su despacho', async () => {
    const service = withReservations(ReservationStatus.CONSUMED, 9);
    const [r] = await service.findReservations(ADMIN, {});
    expect(r).toMatchObject({ status: 'CONSUMED', dispatchId: 'd-9', dispatchCode: 'DES-000009' });
  });

  it('sin despacho (la consumió una OP) no trae despacho', async () => {
    const service = withReservations(ReservationStatus.CONSUMED, null);
    const [r] = await service.findReservations(ADMIN, {});
    expect(r).toMatchObject({ dispatchId: null, dispatchCode: null });
  });

  it('una reserva activa no consulta despachos', async () => {
    const service = withReservations(ReservationStatus.ACTIVE, 9);
    const [r] = await service.findReservations(ADMIN, {});
    expect(r).toMatchObject({ dispatchId: null, dispatchCode: null });
  });
});
