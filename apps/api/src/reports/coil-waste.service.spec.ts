import { Prisma } from '@prisma/client';
import { BusinessLine, Decimal } from '@ayr/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { TOLERANCE_OVERRIDE_AUDIT_ACTION } from '../production/production-shared';
import { CoilWasteService } from './coil-waste.service';

/**
 * cc25 (D-424, D-425, D-429..D-431, D-433). Lo que se fija: el consumo de cada bobina es el de
 * sus salidas de producción en el kardex, la merma se arma con la regla de D-430 sin estimar lo
 * que falta, y el reporte no hace una consulta por bobina.
 */

const D = (v: string) => new Prisma.Decimal(v);
const date = (v: string) => new Date(`${v}T00:00:00.000Z`);
const uuid = (prefix: string, n: number) =>
  `00000000-0000-4000-${prefix}-${String(n).padStart(12, '0')}`;

const COIL = (n: number) => uuid('8000', n);
const REPORT = (n: number) => uuid('9000', n);
const ORDER = (n: number) => uuid('a000', n);

interface Mv {
  itemId: string;
  type: 'IN' | 'OUT';
  qty: string;
  refType: 'PRODUCTION' | 'SCRAP' | 'CLOSE_ADJUSTMENT';
  refId: string | null;
  operationDate?: string;
}

function setup(input: {
  movements: Mv[];
  reports?: { id: string; theoreticalKg: string; order: number; date?: string }[];
  sold?: string[];
  overrides?: {
    reportId: string;
    order: number;
    reason: string;
    detail: string | null;
    pct: string;
  }[];
}) {
  const coilIds = [...new Set(input.movements.map((m) => m.itemId))];
  const inventoryMovement = {
    findMany: jest.fn((args: { where: { refType: unknown } }) => {
      if (args.where.refType === 'SALE') {
        return Promise.resolve((input.sold ?? []).map((itemId) => ({ itemId })));
      }
      return Promise.resolve(
        input.movements.map((m) => ({
          itemId: m.itemId,
          type: m.type,
          qty: D(m.qty),
          refType: m.refType,
          refId: m.refId,
          operationDate: date(m.operationDate ?? '2026-09-10'),
        })),
      );
    }),
  };
  const coil = {
    findMany: jest.fn().mockResolvedValue(
      coilIds.map((id, i) => ({
        id,
        code: `BOB-${String(i + 1).padStart(3, '0')}`,
        kind: 'COIL',
        typeKey: 'ALZ-0.30',
        widthMm: D('1200.00'),
        status: 'OPEN',
        color: { name: 'Natural' },
      })),
    ),
  };
  const productionReport = {
    findMany: jest.fn().mockResolvedValue(
      (input.reports ?? []).map((r) => ({
        id: r.id,
        theoreticalKg: D(r.theoreticalKg),
        operationDate: date(r.date ?? '2026-09-10'),
        productionOrderId: ORDER(r.order),
        productionOrder: { seq: r.order },
      })),
    ),
  };
  const auditLog = {
    findMany: jest.fn().mockResolvedValue(
      (input.overrides ?? []).map((o) => ({
        after: {
          reportId: o.reportId,
          reason: o.reason,
          detail: o.detail,
          differenceKg: '30.000',
          differencePct: o.pct,
        },
      })),
    ),
  };
  const prisma = {
    inventoryMovement,
    coil,
    productionReport,
    auditLog,
  } as unknown as PrismaService;
  const calls = () =>
    inventoryMovement.findMany.mock.calls.length +
    coil.findMany.mock.calls.length +
    productionReport.findMany.mock.calls.length +
    auditLog.findMany.mock.calls.length;
  return { service: new CoilWasteService(prisma), inventoryMovement, auditLog, calls };
}

const RANGE = { from: '2026-09-01', to: '2026-09-30' };

describe('CoilWasteService', () => {
  it('el consumo por bobina es la suma de sus salidas de producción del kardex', async () => {
    const movements: Mv[] = [
      { itemId: COIL(1), type: 'OUT', qty: '400.000', refType: 'PRODUCTION', refId: REPORT(1) },
      { itemId: COIL(1), type: 'OUT', qty: '250.500', refType: 'PRODUCTION', refId: REPORT(2) },
      { itemId: COIL(2), type: 'OUT', qty: '100.000', refType: 'PRODUCTION', refId: REPORT(3) },
      { itemId: COIL(1), type: 'OUT', qty: '6.000', refType: 'SCRAP', refId: ORDER(1) },
    ];
    const { service } = setup({
      movements,
      reports: [
        { id: REPORT(1), theoreticalKg: '400.000', order: 1 },
        { id: REPORT(2), theoreticalKg: '250.500', order: 1 },
        { id: REPORT(3), theoreticalKg: '100.000', order: 2 },
      ],
    });
    const report = await service.report(RANGE);

    for (const row of report.rows) {
      const kardex = movements
        .filter((m) => m.itemId === row.coilId && m.refType === 'PRODUCTION')
        .reduce((acc, m) => acc.plus(m.qty), new Decimal(0));
      expect(row.consumedKg).toBe(kardex.toFixed(3));
    }
    expect(report.totals.consumedKg).toBe('750.500');
    expect(report.rows.map((r) => r.productions.length)).toEqual([2, 1]);
  });

  it('merma = (consumido − teórico) + despunte + ajuste de cierre, sobre el teórico (D-430)', async () => {
    const { service } = setup({
      movements: [
        // Un reporte topado en lo montado: salió menos que su teórico (D-246).
        { itemId: COIL(1), type: 'OUT', qty: '990.000', refType: 'PRODUCTION', refId: REPORT(1) },
        // Despunte del cierre de la OP (refId = la orden).
        { itemId: COIL(1), type: 'OUT', qty: '15.000', refType: 'SCRAP', refId: ORDER(1) },
        // Merma manual de RF-17 (refId = la bobina): informativa (D-431).
        { itemId: COIL(1), type: 'OUT', qty: '7.000', refType: 'SCRAP', refId: COIL(1) },
        // Cierre de bobina: el conteo dio de más, entra y resta (D-164).
        { itemId: COIL(1), type: 'IN', qty: '2.000', refType: 'CLOSE_ADJUSTMENT', refId: COIL(1) },
      ],
      reports: [{ id: REPORT(1), theoreticalKg: '1000.000', order: 1 }],
    });
    const [row] = (await service.report(RANGE)).rows;
    expect(row).toMatchObject({
      consumedKg: '990.000',
      theoreticalKg: '1000.000',
      differenceKg: '-10.000',
      trimKg: '15.000',
      closeAdjustmentKg: '-2.000',
      wasteKg: '3.000',
      wastePct: '0.30',
      overStandard: false,
      manualScrapKg: '7.000',
    });
  });

  it('pasa el 1 % estándar y lo marca', async () => {
    const { service } = setup({
      movements: [
        { itemId: COIL(1), type: 'OUT', qty: '500.000', refType: 'PRODUCTION', refId: REPORT(1) },
        { itemId: COIL(1), type: 'OUT', qty: '10.000', refType: 'SCRAP', refId: ORDER(1) },
        { itemId: COIL(1), type: 'OUT', qty: '4.000', refType: 'CLOSE_ADJUSTMENT', refId: COIL(1) },
      ],
      reports: [{ id: REPORT(1), theoreticalKg: '500.000', order: 1 }],
    });
    const report = await service.report(RANGE);
    expect(report.rows[0]).toMatchObject({
      wasteKg: '14.000',
      wastePct: '2.80',
      overStandard: true,
    });
    expect(report.standardPct).toBe('1.00');
    expect(report.totals).toMatchObject({ wasteKg: '14.000', wastePct: '2.80' });
  });

  it('un reporte de varias bobinas: si salió por su teórico, cada una lleva lo suyo; si no, se declara (D-433)', async () => {
    const { service } = setup({
      movements: [
        // REPORT(1): 300 teórico, salió 200 + 100 → atribuible.
        { itemId: COIL(1), type: 'OUT', qty: '200.000', refType: 'PRODUCTION', refId: REPORT(1) },
        { itemId: COIL(2), type: 'OUT', qty: '100.000', refType: 'PRODUCTION', refId: REPORT(1) },
        // REPORT(2): 300 teórico, salió 150 + 140 (topado) → no se reparte.
        { itemId: COIL(3), type: 'OUT', qty: '150.000', refType: 'PRODUCTION', refId: REPORT(2) },
        { itemId: COIL(4), type: 'OUT', qty: '140.000', refType: 'PRODUCTION', refId: REPORT(2) },
      ],
      reports: [
        { id: REPORT(1), theoreticalKg: '300.000', order: 1 },
        { id: REPORT(2), theoreticalKg: '300.000', order: 2 },
      ],
    });
    const report = await service.report(RANGE);
    const [a, b, c, d] = report.rows;
    expect([a?.theoreticalKg, b?.theoreticalKg]).toEqual(['200.000', '100.000']);
    expect([c?.theoreticalKg, d?.theoreticalKg]).toEqual([null, null]);
    expect(c?.wastePct).toBeNull();
    expect(c?.productions[0]?.missingTheoretical).toBe('SPLIT_NOT_THEORETICAL');
    // Los totales comparables no estiman la parte que falta.
    expect(report.totals).toMatchObject({
      coilCount: 4,
      consumedKg: '590.000',
      comparableCoilCount: 2,
      comparableConsumedKg: '300.000',
      theoreticalKg: '300.000',
    });
  });

  it('sin reporte o con teórico cero, la producción se declara sin teórico', async () => {
    const { service } = setup({
      movements: [
        { itemId: COIL(1), type: 'OUT', qty: '50.000', refType: 'PRODUCTION', refId: null },
        { itemId: COIL(2), type: 'OUT', qty: '20.000', refType: 'PRODUCTION', refId: REPORT(2) },
      ],
      reports: [{ id: REPORT(2), theoreticalKg: '0.000', order: 2 }],
    });
    const report = await service.report(RANGE);
    expect(report.rows.map((r) => r.productions[0]?.missingTheoretical)).toEqual([
      'NO_REPORT',
      'ZERO_THEORETICAL',
    ]);
    expect(report.totals.wastePct).toBeNull();
  });

  it('la producción confirmada con la casilla lleva «Fuera de tolerancia» y su motivo', async () => {
    const { service } = setup({
      movements: [
        { itemId: COIL(1), type: 'OUT', qty: '980.000', refType: 'PRODUCTION', refId: REPORT(1) },
        { itemId: COIL(1), type: 'OUT', qty: '100.000', refType: 'PRODUCTION', refId: REPORT(2) },
      ],
      reports: [
        { id: REPORT(1), theoreticalKg: '1010.000', order: 1 },
        { id: REPORT(2), theoreticalKg: '100.000', order: 1 },
      ],
      overrides: [
        { reportId: REPORT(1), order: 1, reason: 'LIGHTER_COIL', detail: null, pct: '3.07' },
      ],
    });
    const report = await service.report(RANGE);
    const productions = report.rows[0]?.productions ?? [];
    const flagged = productions.find((p) => p.reportId === REPORT(1));
    expect(flagged?.outOfTolerance).toEqual({
      label: 'Bobina más liviana que el nominal',
      excessPct: '3.07',
    });
    expect(productions.find((p) => p.reportId === REPORT(2))?.outOfTolerance).toBeNull();
  });

  it('una bobina revendida después de producir sigue en el reporte; la venta ni se consulta (D-436)', async () => {
    const { service, inventoryMovement } = setup({
      movements: [
        { itemId: COIL(1), type: 'OUT', qty: '100.000', refType: 'PRODUCTION', refId: REPORT(1) },
        { itemId: COIL(2), type: 'OUT', qty: '30.000', refType: 'PRODUCTION', refId: REPORT(2) },
      ],
      reports: [
        { id: REPORT(1), theoreticalKg: '100.000', order: 1 },
        { id: REPORT(2), theoreticalKg: '30.000', order: 2 },
      ],
      sold: [COIL(2)],
    });
    const report = await service.report(RANGE);
    expect(report.rows.map((r) => r.coilId)).toEqual([COIL(1), COIL(2)]);
    expect(report.totals.consumedKg).toBe('130.000');
    expect(inventoryMovement.findMany).toHaveBeenCalledTimes(1);
  });

  it('entra por despunte o ajuste de cierre sin producción en el rango (D-435)', async () => {
    const { service } = setup({
      movements: [
        // La OP se cerró este mes; sus reportes fueron el anterior.
        { itemId: COIL(1), type: 'OUT', qty: '12.000', refType: 'SCRAP', refId: ORDER(1) },
        // La bobina se cerró este mes.
        { itemId: COIL(2), type: 'OUT', qty: '4.000', refType: 'CLOSE_ADJUSTMENT', refId: COIL(2) },
      ],
    });
    const report = await service.report(RANGE);
    expect(
      report.rows.map((r) => [
        r.consumedKg,
        r.theoreticalKg,
        r.trimKg,
        r.closeAdjustmentKg,
        r.wasteKg,
        r.wastePct,
      ]),
    ).toEqual([
      ['0.000', '0.000', '12.000', '0.000', '12.000', null],
      ['0.000', '0.000', '0.000', '4.000', '4.000', null],
    ]);
    expect(report.rows.every((r) => r.productions.length === 0)).toBe(true);
    // Dos meses seguidos suman exacto: la merma de este mes queda en este mes.
    expect(report.totals).toMatchObject({ wasteKg: '16.000', wastePct: null, overStandard: false });
  });

  it('el rojo empieza pasado el 1 % sobre el estándar, y un valor negativo va tal cual (D-434)', async () => {
    const { service } = setup({
      movements: [
        { itemId: COIL(1), type: 'OUT', qty: '1000.000', refType: 'PRODUCTION', refId: REPORT(1) },
        { itemId: COIL(1), type: 'OUT', qty: '10.000', refType: 'SCRAP', refId: ORDER(1) },
        { itemId: COIL(2), type: 'OUT', qty: '980.000', refType: 'PRODUCTION', refId: REPORT(2) },
      ],
      reports: [
        { id: REPORT(1), theoreticalKg: '1000.000', order: 1 },
        { id: REPORT(2), theoreticalKg: '1000.000', order: 2 },
      ],
    });
    const report = await service.report(RANGE);
    expect(report.rows.map((r) => [r.wastePct, r.overStandard])).toEqual([
      ['1.00', false],
      ['-2.00', false],
    ]);
  });

  it('una bobina con solo merma manual en el rango no entra (D-431)', async () => {
    const { service, calls } = setup({
      movements: [{ itemId: COIL(1), type: 'OUT', qty: '7.000', refType: 'SCRAP', refId: COIL(1) }],
    });
    const report = await service.report(RANGE);
    expect(report.rows).toEqual([]);
    expect(report.totals.wastePct).toBeNull();
    // Sin bobinas en el rango, una sola consulta.
    expect(calls()).toBe(1);
  });

  it('consultas fijas: cuatro como máximo, sin una por bobina ni por reporte', async () => {
    const movements: Mv[] = [];
    const reports = [];
    for (let i = 1; i <= 40; i += 1) {
      movements.push({
        itemId: COIL(i),
        type: 'OUT',
        qty: '10.000',
        refType: 'PRODUCTION',
        refId: REPORT(i),
      });
      movements.push({
        itemId: COIL(i),
        type: 'OUT',
        qty: '0.500',
        refType: 'SCRAP',
        refId: ORDER(i),
      });
      reports.push({ id: REPORT(i), theoreticalKg: '10.000', order: i });
    }
    const { service, calls } = setup({ movements, reports });
    const report = await service.report(RANGE);
    expect(report.rows).toHaveLength(40);
    expect(calls()).toBeLessThanOrEqual(4);
  });

  it('lee solo movimientos vivos, del rango y de la línea de la pestaña', async () => {
    const { service, inventoryMovement, auditLog } = setup({
      movements: [
        { itemId: COIL(1), type: 'OUT', qty: '10.000', refType: 'PRODUCTION', refId: REPORT(1) },
      ],
      reports: [{ id: REPORT(1), theoreticalKg: '10.000', order: 1 }],
    });
    await service.report({ ...RANGE, businessLine: BusinessLine.DRYWALL });
    const [[args]] = inventoryMovement.findMany.mock.calls as unknown as [
      [{ where: Record<string, unknown> }],
    ];
    expect(args.where).toMatchObject({
      itemType: 'COIL',
      reversalOfId: null,
      reversals: { none: {} },
      operationDate: { gte: date('2026-09-01'), lte: date('2026-09-30') },
      businessLine: { code: 'DRYWALL' },
    });
    const [[audit]] = auditLog.findMany.mock.calls as unknown as [
      [{ where: { action: string; entityId: { in: string[] } } }],
    ];
    expect(audit.where.action).toBe(TOLERANCE_OVERRIDE_AUDIT_ACTION);
    expect(audit.where.entityId.in).toEqual([ORDER(1)]);
  });
});
