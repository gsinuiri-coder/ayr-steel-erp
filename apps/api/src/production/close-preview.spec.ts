import { BadRequestException } from '@nestjs/common';
import { CoilStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { previewPlantClose } from './close-preview';

/**
 * cc27 (UX26-03, D-453; autorrevisión A-4). La vista previa de un cierre corre la acción real en
 * una transacción **que nunca se confirma**: lo que la acción escribió se lee y la transacción se
 * deshace lanzando. Este spec simula el contrato de `$transaction` de Prisma (lo que lanza el
 * callback deshace y se relanza) y fija que el resumen sale del estado intermedio y que nada se
 * confirma.
 */

const ORDER = '11111111-1111-4111-8111-111111111111';
const COIL_A = '22222222-2222-4222-8222-222222222222';
const COIL_B = '33333333-3333-4333-8333-333333333333';

interface FakeState {
  balances: Map<string, string>;
  status: Map<string, CoilStatus>;
  scrapKg: string | null;
  reports: { id: string; rawMaterialWarning: string | null }[];
  /** cc35: salidas SCRAP de la orden (las viejas, de un cierre reabierto, no cuentan). */
  scraps: { id: bigint; itemId: string; qty: string }[];
}

function fakePrisma(state: FakeState) {
  const result = { committed: false };
  const tx = {
    // cc28 (A-6): la vista previa bloquea la orden antes de leer el «antes».
    $queryRaw: jest.fn(() => Promise.resolve([{ id: ORDER }])),
    productionOrder: {
      findUniqueOrThrow: jest.fn(({ select }: { select: Record<string, true> }) =>
        Promise.resolve(select.seq ? { seq: 7 } : { scrapKg: state.scrapKg }),
      ),
    },
    productionOrderConsumption: {
      findMany: jest.fn(() => Promise.resolve([{ coilId: COIL_A }, { coilId: COIL_B }])),
    },
    productionReport: {
      findMany: jest.fn(({ where }: { where: { id?: { notIn: string[] } } }) =>
        Promise.resolve(
          where.id
            ? state.reports.filter((r) => !where.id!.notIn.includes(r.id))
            : state.reports.map((r) => ({ id: r.id })),
        ),
      ),
    },
    inventoryMovement: {
      findMany: jest.fn(({ where }: { where: { id?: { notIn: bigint[] } } }) =>
        Promise.resolve(
          where.id
            ? state.scraps
                .filter((m) => !where.id!.notIn.includes(m.id))
                .map((m) => ({ itemId: m.itemId, qty: { toString: () => m.qty } }))
            : state.scraps.map((m) => ({ id: m.id })),
        ),
      ),
    },
    coil: {
      findMany: jest.fn(() =>
        Promise.resolve(
          [COIL_A, COIL_B].map((id) => ({
            id,
            code: id === COIL_A ? 'B-A' : 'B-B',
            status: state.status.get(id),
          })),
        ),
      ),
    },
    inventoryBalance: {
      findMany: jest.fn(() =>
        Promise.resolve(
          [...state.balances].map(([itemId, qty]) => ({ itemId, qty: { toString: () => qty } })),
        ),
      ),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      // Contrato de Prisma: si el callback lanza, se deshace y se relanza; si no, se confirma.
      const value = await fn(tx);
      result.committed = true;
      return value;
    }),
  };
  return { prisma: prisma as unknown as PrismaService, result };
}

describe('previewPlantClose (D-453)', () => {
  it('resume lo que la acción haría y nunca confirma la transacción', async () => {
    const state: FakeState = {
      balances: new Map([
        [COIL_A, '1000.000'],
        [COIL_B, '50.000'],
      ]),
      status: new Map([
        [COIL_A, CoilStatus.OPEN],
        [COIL_B, CoilStatus.OPEN],
      ]),
      scrapKg: null,
      reports: [{ id: 'r0', rawMaterialWarning: null }],
      // Un despunte de un cierre anterior, reabierto: no es de esta acción.
      scraps: [{ id: 1n, itemId: COIL_B, qty: '5.000' }],
    };
    const { prisma, result } = fakePrisma(state);

    const preview = await previewPlantClose(
      prisma,
      ORDER,
      () => {
        // La «acción»: saca kilos de las dos bobinas, termina la B, suelta despunte y agrega un
        // reporte fuera de tolerancia.
        state.balances.set(COIL_A, '600.500');
        state.balances.set(COIL_B, '0.000');
        state.status.set(COIL_B, CoilStatus.CLOSED);
        state.scrapKg = '12.250';
        state.scraps.push({ id: 2n, itemId: COIL_A, qty: '12.250' });
        state.reports.push({
          id: 'r1',
          rawMaterialWarning: 'Fuera de tolerancia, confirmado con la casilla: Otro.',
        });
        return Promise.resolve();
      },
      60_000,
    );

    expect(result.committed).toBe(false);
    expect(preview).toEqual({
      orderId: ORDER,
      orderCode: 'OP-000007',
      coils: [
        {
          coilId: COIL_A,
          coilCode: 'B-A',
          consumedKg: '399.500',
          balanceBeforeKg: '1000.000',
          balanceAfterKg: '600.500',
          terminated: false,
          scrapKg: '12.250',
        },
        {
          coilId: COIL_B,
          coilCode: 'B-B',
          consumedKg: '50.000',
          balanceBeforeKg: '50.000',
          balanceAfterKg: '0.000',
          terminated: true,
          scrapKg: '0.000',
        },
      ],
      scrapKg: '12.250',
      outOfTolerance: ['Fila 1: Fuera de tolerancia, confirmado con la casilla: Otro.'],
      warnings: [],
    });
  });

  it('el rechazo de la acción sale tal cual (motivo, casilla, fecha) y tampoco confirma', async () => {
    const state: FakeState = {
      balances: new Map([[COIL_A, '10.000']]),
      status: new Map([[COIL_A, CoilStatus.OPEN]]),
      scrapKg: null,
      reports: [],
      scraps: [],
    };
    const { prisma, result } = fakePrisma(state);
    await expect(
      previewPlantClose(
        prisma,
        ORDER,
        () =>
          Promise.reject(new BadRequestException('explica el motivo para cerrar con esa merma')),
        60_000,
      ),
    ).rejects.toThrow('explica el motivo');
    expect(result.committed).toBe(false);
  });
});
