import { Prisma } from '@prisma/client';
import { productionSummaryQuerySchema } from '@ayr/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { productionSummaryXlsx } from './production-summary-xlsx';
import { ProductionSummaryService } from './production-summary.service';

/**
 * cc29 (M2, D-464, D-468) — el reporte de producción por OP: cifras del kardex del rango, teórico
 * por OP sin repartir, despunte de la OP con su reparto por bobina tal como lo registró el kardex,
 * subtotal por pedido, costos solo para el administrador y presupuesto de consultas fijo.
 */

const D = (v: string) => new Prisma.Decimal(v);
const uuid = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
const C1 = uuid(1);
const C2 = uuid(2);
const C3 = uuid(3);
const OP_A = uuid(11);
const OP_B = uuid(12);
const OP_C = uuid(13);
const R1 = uuid(21);
const R3 = uuid(23);
const R4 = uuid(24);
const SO = uuid(31);

function mov(
  itemId: string,
  refType: string,
  refId: string,
  qty: string,
  cost: string,
  type = 'OUT',
) {
  return { itemId, type, qty: D(qty), totalCost: D(cost), refType, refId };
}

const MOVEMENTS = [
  // R1 (OP A) salió de dos bobinas: 600 + 400 = su teórico de 1 000.
  mov(C1, 'PRODUCTION', R1, '600.000', '2400.0000'),
  mov(C2, 'PRODUCTION', R1, '400.000', '1600.0000'),
  // El despunte del cierre de A, registrado en C2.
  mov(C2, 'SCRAP', OP_A, '30.000', '120.0000'),
  mov(C1, 'PRODUCTION', R3, '505.000', '2020.0000'),
  mov(C3, 'PRODUCTION', R4, '100.000', '400.0000'),
  // Merma manual (RF-17): apunta a la bobina, no es de ninguna OP.
  mov(C3, 'SCRAP', C3, '10.000', '40.0000'),
  // Una salida de producción que no apunta a un reporte.
  mov(C3, 'PRODUCTION', 'carga-manual', '7.000', '28.0000'),
];

const order = (id: string, seq: number, unit: string, reservation: { line: number } | null) => ({
  id,
  seq,
  status: 'CLOSED',
  productId: uuid(40 + seq),
  product: { sku: `SKU-${String(seq)}`, name: `Producto ${String(seq)}`, unit },
  reservation:
    reservation === null
      ? null
      : {
          salesOrderId: SO,
          salesOrder: { seq: 5 },
          salesOrderItem: { lineNumber: reservation.line },
        },
});

function build(movements = MOVEMENTS) {
  const prisma = {
    inventoryMovement: { findMany: jest.fn().mockResolvedValue(movements) },
    productionReport: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: R1,
          productionOrderId: OP_A,
          pieces: 10,
          metersM: D('300.000'),
          theoreticalKg: D('1000.000'),
        },
        { id: R3, productionOrderId: OP_B, pieces: 20, metersM: null, theoreticalKg: D('500.000') },
        { id: R4, productionOrderId: OP_C, pieces: 5, metersM: null, theoreticalKg: D('100.000') },
      ]),
    },
    productionOrder: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          order(OP_A, 10, 'MTR', { line: 2 }),
          order(OP_B, 11, 'NIU', { line: 1 }),
          order(OP_C, 12, 'NIU', null),
        ]),
    },
    coil: {
      findMany: jest.fn().mockResolvedValue([
        { id: C1, code: 'BOB-1' },
        { id: C2, code: 'BOB-2' },
        { id: C3, code: 'BOB-3' },
      ]),
    },
  };
  const calls = () =>
    prisma.inventoryMovement.findMany.mock.calls.length +
    prisma.productionReport.findMany.mock.calls.length +
    prisma.productionOrder.findMany.mock.calls.length +
    prisma.coil.findMany.mock.calls.length;
  return {
    service: new ProductionSummaryService(prisma as unknown as PrismaService),
    prisma,
    calls,
  };
}

const RANGE = { from: '2026-10-01', to: '2026-10-06' };

describe('ProductionSummaryService', () => {
  it('una fila por OP, agrupadas por pedido y por línea; las corridas sin pedido al final', async () => {
    const { service } = build();
    const report = await service.report(RANGE, true);
    expect(report.groups.map((g) => [g.salesOrderCode, g.orders.map((o) => o.code)])).toEqual([
      ['PED-000005', ['OP-000011', 'OP-000010']],
      [null, ['OP-000012']],
    ]);
    const [b, a] = report.groups[0]!.orders;
    expect(a).toMatchObject({
      lineNumber: 2,
      productSku: 'SKU-10',
      quantity: '300.000',
      quantityUnit: 'm',
      reportCount: 1,
      theoreticalKg: '1000.000',
      consumedKg: '1000.000',
      trimKg: '30.000',
      // (1 000 − 1 000 + 30) ÷ 1 000.
      wastePct: '3.00',
      overStandard: true,
      materialCostPen: '4000.0000',
      trimCostPen: '120.0000',
    });
    // El detalle por bobina: lo que cada una dio según el kardex; el despunte, donde se registró.
    expect(a!.coils).toEqual([
      { coilId: C1, code: 'BOB-1', consumedKg: '600.000', trimKg: '0.000' },
      { coilId: C2, code: 'BOB-2', consumedKg: '400.000', trimKg: '30.000' },
    ]);
    expect(b).toMatchObject({
      lineNumber: 1,
      quantity: '20',
      quantityUnit: 'pzs',
      wastePct: '1.00',
      overStandard: false,
    });
    expect(report.groups[0]!.subtotal).toMatchObject({
      theoreticalKg: '1500.000',
      consumedKg: '1505.000',
      trimKg: '30.000',
      wastePct: '2.33',
      overStandard: true,
    });
  });

  it('los totales cuadran con el kardex de producción del rango, con lo que no es de un reporte aparte', async () => {
    const { service } = build();
    const report = await service.report(RANGE, true);
    expect(report.totals).toMatchObject({
      orderCount: 3,
      theoreticalKg: '1600.000',
      consumedKg: '1605.000',
      trimKg: '30.000',
      wastePct: '2.19',
      unattributedKg: '7.000',
    });
    // 600 + 400 + 505 + 100 + 7 = todas las salidas PRODUCTION del rango.
    const kardex = MOVEMENTS.filter((m) => m.refType === 'PRODUCTION').reduce(
      (acc, m) => acc.plus(m.qty),
      D('0'),
    );
    expect(D(report.totals.consumedKg).plus(report.totals.unattributedKg).toFixed(3)).toBe(
      kardex.toFixed(3),
    );
  });

  it('sin costos para el supervisor de planta', async () => {
    const { service } = build();
    const report = await service.report(RANGE, false);
    expect(report.withCosts).toBe(false);
    const all = [
      report.totals,
      ...report.groups.map((g) => g.subtotal),
      ...report.groups.flatMap((g) => g.orders),
    ];
    for (const f of all) {
      expect(f.materialCostPen).toBeNull();
      expect(f.trimCostPen).toBeNull();
    }
  });

  it('presupuesto de consultas: cuatro con movimientos, una sin ellos', async () => {
    const full = build();
    await full.service.report(RANGE, true);
    expect(full.calls()).toBe(4);
    const empty = build([]);
    const report = await empty.service.report(RANGE, true);
    expect(empty.calls()).toBe(1);
    expect(report.groups).toEqual([]);
    expect(report.totals.wastePct).toBeNull();
  });

  it('lee solo movimientos vivos, del rango y de la línea de la pestaña; Coberturas Aluzinc por defecto', async () => {
    const { service, prisma } = build();
    await service.report({ ...RANGE, businessLine: 'drywall' }, true);
    await service.report(RANGE, true);
    const [[drywall], [roofing]] = prisma.inventoryMovement.findMany.mock.calls as unknown as [
      [{ where: Record<string, unknown> }],
      [{ where: Record<string, unknown> }],
    ];
    expect(drywall.where).toMatchObject({
      itemType: 'COIL',
      refType: { in: ['PRODUCTION', 'SCRAP'] },
      reversalOfId: null,
      reversals: { none: {} },
      businessLine: { code: 'DRYWALL' },
    });
    expect(roofing.where).toMatchObject({ businessLine: { code: 'METALLIC_ROOFING' } });
  });

  it('el rango se valida en el borde', () => {
    expect(
      productionSummaryQuerySchema.safeParse({ from: '2026-10-06', to: '2026-10-01' }).success,
    ).toBe(false);
    expect(
      productionSummaryQuerySchema.safeParse({ ...RANGE, businessLine: 'services' }).success,
    ).toBe(false);
  });

  it('el Excel sale del mismo DTO: con costos solo si el DTO los trae', async () => {
    const { service } = build();
    const admin = productionSummaryXlsx(await service.report(RANGE, true));
    const plant = productionSummaryXlsx(await service.report(RANGE, false));
    expect(admin.filename).toBe('produccion-metallic-roofing-2026-10-01-2026-10-06.xlsx');
    expect(admin.buffer.length).toBeGreaterThan(0);
    expect(plant.buffer.length).toBeGreaterThan(0);
  });
});
