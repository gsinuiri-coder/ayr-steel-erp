import {
  ProductionOrderKind,
  ProductionOrderStatus,
  RoofingProductKind,
  type Prisma,
} from '@prisma/client';
import { Decimal, kgPerMeter, Role } from '@ayr/shared';
import type * as guardModule from '../sales/reservation-guard';
import type * as transferModule from '../sales/reservation-transfer';
import { RoofingProductionService } from './roofing-production.service';

jest.mock('../sales/reservation-guard', () => ({
  ...jest.requireActual<typeof guardModule>('../sales/reservation-guard'),
  consumeReservationQty: jest.fn().mockResolvedValue(new Decimal(0)),
}));
jest.mock('../sales/reservation-transfer', () => ({
  ...jest.requireActual<typeof transferModule>('../sales/reservation-transfer'),
  findLineReservation: jest.fn().mockResolvedValue(null),
  upsertItemReservation: jest.fn().mockResolvedValue('res-pt'),
}));

/**
 * **D-343 — el reporte de una orden de accesorio: metros lineales de bobina, sin largos.**
 *
 * `reportInTx` acepta `meters` para un accesorio y `pieces` para todo lo demás, y nunca al revés.
 * Los metros son el dato de primera clase: de ellos salen los kilos teóricos (con el ancho de la
 * bobina montada), lo que entra al kardex del producto terminado (en metros) y el aviso —no el
 * bloqueo— cuando se pasan de lo que el pedido encargó. Las piezas son solo información.
 */

const D = (v: string) => new Decimal(v);
const ACTOR = {
  id: 'u-1',
  email: 'a@ayr.test',
  name: 'Admin',
  role: Role.ADMINISTRADOR,
  mustChangePassword: false,
  sessionId: 's-1',
};
const WIDTH = '1220.00';
const THICKNESS = '0.30';
const DENSITY = '8.0500';
const KG_PER_METER = kgPerMeter({ widthMm: WIDTH, thicknessMm: THICKNESS, densityFactor: DENSITY });

interface Setup {
  roofingKind: RoofingProductKind | null;
  unit?: string;
  /** Metros ya reportados por reportes vigentes. */
  reportedMl?: string;
  /** Metros que encargó la línea del pedido. */
  orderedMl?: string;
  /** Kilos que quedan montados en la bobina. */
  remainingKg?: string;
}

function build(setup: Setup) {
  const created: Record<string, unknown>[] = [];
  const auditWrites: { after?: Record<string, unknown> }[] = [];
  const movements: Record<string, unknown>[] = [];
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'o-1' }]),
    productionOrder: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'o-1',
        seq: 7,
        kind: ProductionOrderKind.ROOFING,
        status: ProductionOrderStatus.IN_PROGRESS,
        businessLineId: 'bl-roofing',
        productId: 'p-acc',
        bomId: null,
        notes: null,
        closedAt: null,
        reservationId: 'res-1',
      }),
    },
    product: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        sku: setup.roofingKind === RoofingProductKind.ACCESORIO ? 'ACCES030ROJO' : 'COB030ROJO',
        unit: setup.unit ?? 'MTR',
        lengthMm: null,
        roofingKind: setup.roofingKind,
      }),
    },
    productionOrderConsumption: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'c-1',
          coilId: 'coil-1',
          assignedKg: D('1000'),
          consumedKg: D('1000').minus(D(setup.remainingKg ?? '1000')),
          coil: {
            code: 'BOB-1',
            widthMm: D(WIDTH),
            thicknessMm: D(THICKNESS),
            finish: { densityFactor: D(DENSITY) },
          },
        },
      ]),
      update: jest.fn(),
    },
    productionOrderItem: { findMany: jest.fn().mockResolvedValue([]) },
    productionReport: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest
        .fn()
        .mockResolvedValue(
          setup.reportedMl === undefined
            ? []
            : [{ consumedKg: null, metersM: D(setup.reportedMl), piecesDetail: [] }],
        ),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return Promise.resolve({ id: 'rep-1' });
      }),
      update: jest.fn(),
    },
    reservation: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        salesOrderId: 'so-1',
        salesOrderItemId: 'it-1',
        itemId: 'spec-1',
        salesOrderItem: { qty: D(setup.orderedMl ?? '100') },
      }),
    },
    salesOrder: { updateMany: jest.fn() },
    salesOrderItem: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ qty: D(setup.orderedMl ?? '100') }),
    },
  };
  const inventory = {
    record: jest.fn((_tx: unknown, args: { type: string; itemType: string; qty: string }) => {
      movements.push(args);
      return Promise.resolve({ totalCost: D('50') });
    }),
  };
  const audit = {
    write: jest.fn((_tx: unknown, entry: { after?: Record<string, unknown> }) => {
      auditWrites.push(entry);
    }),
  };
  const service = new RoofingProductionService(
    {} as never,
    audit as never,
    inventory as never,
    { lockCoil: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return {
    service,
    tx: tx as unknown as Prisma.TransactionClient,
    rawTx: tx,
    created,
    auditWrites,
    movements,
  };
}

describe('reportInTx de una orden de accesorio (D-343)', () => {
  it('reporta metros: kilos teóricos con el ancho de la bobina, entrada al kardex en metros y ninguna fila de largos', async () => {
    const { service, tx, created, movements } = build({
      roofingKind: RoofingProductKind.ACCESORIO,
    });
    await service.reportInTx(tx, ACTOR, 'o-1', { meters: '25.000' }, '2026-09-26');

    const report = created[0]!;
    // Los metros van directo a `meters_m`; las piezas informativas, ausentes, quedan en cero.
    expect(report.metersM).toBe('25.000');
    expect(report.pieces).toBe(0);
    expect(report.theoreticalKg).toBe(KG_PER_METER.times(25).toFixed(3));
    // Sin detalle de largos: no hay `production_report_pieces`.
    expect(report).not.toHaveProperty('piecesDetail');

    // Sale la bobina en kilos y entra el producto terminado **en metros**.
    const out = movements.find((m) => m.type === 'OUT');
    const entry = movements.find((m) => m.type === 'IN');
    expect(out).toMatchObject({
      itemType: 'COIL',
      unit: 'KGM',
      qty: KG_PER_METER.times(25).toFixed(3),
    });
    expect(entry).toMatchObject({ itemType: 'PRODUCT', unit: 'MTR', qty: '25.000' });
    expect(String(entry?.notes)).toContain('25.000 m de bobina');
  });

  it('las piezas informativas se guardan tal cual y no cambian ningún número', async () => {
    const results: Record<string, unknown>[] = [];
    const movementQty: string[] = [];
    for (const piecesCount of [undefined, 1, 40, 900]) {
      const { service, tx, created, movements } = build({
        roofingKind: RoofingProductKind.ACCESORIO,
      });
      await service.reportInTx(
        tx,
        ACTOR,
        'o-1',
        { meters: '25.000', ...(piecesCount === undefined ? {} : { piecesCount }) },
        '2026-09-26',
      );
      results.push(created[0]!);
      movementQty.push(movements.map((m) => `${String(m.type)}:${String(m.qty)}`).join('|'));
    }
    expect(results.map((r) => r.pieces)).toEqual([0, 1, 40, 900]);
    for (const r of results) {
      expect(r.metersM).toBe('25.000');
      expect(r.theoreticalKg).toBe(results[0]?.theoreticalKg);
    }
    expect(new Set(movementQty).size).toBe(1);
  });

  it('un accesorio que reporta largos es un 400, y una cobertura que reporta metros también', async () => {
    const acc = build({ roofingKind: RoofingProductKind.ACCESORIO });
    await expect(
      acc.service.reportInTx(
        acc.tx,
        ACTOR,
        'o-1',
        { pieces: [{ lengthMm: '6000', qty: 2 }] },
        '2026-09-26',
      ),
    ).rejects.toThrow(/es un accesorio: reporta los metros lineales/);
    const cob = build({ roofingKind: RoofingProductKind.A_MEDIDA });
    await expect(
      cob.service.reportInTx(cob.tx, ACTOR, 'o-1', { meters: '25.000' }, '2026-09-26'),
    ).rejects.toThrow(/no es un accesorio: detalla los largos/);
  });

  it('pasarse de los metros encargados avisa y no bloquea', async () => {
    const { service, tx, created, auditWrites } = build({
      roofingKind: RoofingProductKind.ACCESORIO,
      orderedMl: '20',
      reportedMl: '10',
    });
    // 10 ya reportados + 25 = 35 m contra 20 encargados.
    await service.reportInTx(tx, ACTOR, 'o-1', { meters: '25.000' }, '2026-09-26');
    expect(created).toHaveLength(1);
    const audit = auditWrites[0]?.after as { rawMaterialWarning?: string };
    expect(audit.rawMaterialWarning).toMatch(/35\.000 m de bobina y el pedido encargó 20\.000 m/);
    expect(audit.rawMaterialWarning).toMatch(/rindió más de lo planeado/);
  });

  it('dentro de lo encargado no hay aviso de rendimiento', async () => {
    const { service, tx, auditWrites } = build({
      roofingKind: RoofingProductKind.ACCESORIO,
      orderedMl: '100',
      reportedMl: '10',
    });
    await service.reportInTx(tx, ACTOR, 'o-1', { meters: '25.000' }, '2026-09-26');
    expect(
      (auditWrites[0]?.after as { rawMaterialWarning: string | null }).rawMaterialWarning,
    ).toBeNull();
  });

  it('el reporte de una cobertura a medida sigue exigiendo y guardando sus largos (D-083 no se mueve)', async () => {
    const { service, tx, created } = build({ roofingKind: RoofingProductKind.A_MEDIDA });
    await service.reportInTx(
      tx,
      ACTOR,
      'o-1',
      { pieces: [{ lengthMm: '6000', qty: 2 }] },
      '2026-09-26',
    );
    const report = created[0] as { pieces: number; metersM: string; piecesDetail: unknown };
    expect(report.pieces).toBe(2);
    expect(report.metersM).toBe('12.000');
    expect(report.piecesDetail).toEqual({
      create: [{ lineNumber: 1, lengthMm: '6000.00', qty: 2 }],
    });
  });
});
