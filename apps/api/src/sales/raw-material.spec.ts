import { BadRequestException } from '@nestjs/common';
import { Prisma, type Prisma as PrismaTypes } from '@prisma/client';
import { assertRawMaterialInvariant, rawMaterialAvailability } from './raw-material';

/**
 * La invariante del agregado (D-134).
 *
 * Tiene tests propios por la misma razón que los tiene `reservation-guard`: es un guardrail
 * que **no** protege el compilador. El enum `RAW_MATERIAL` es aditivo, así que ningún
 * `switch` se rompe al agregarlo, y la aritmética del disponible —físico menos lo
 * comprometido por ítem menos lo prometido de forma genérica, sin contar lo que una OP tiene
 * montado— es exactamente la clase de cuenta que se puede equivocar en silencio.
 */

const LINE = 'line-1';
const SPEC = { id: 'spec-1', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' };
const TOLERANCE = '0.02';

interface FakeState {
  /** Bobinas que el filtro devuelve, en orden de id. */
  coils: { id: string; businessLineId: string; colorId: string | null; thicknessMm: string }[];
  balances: { itemId: string; qty: string }[];
  /** Reservas por ítem (venta de bobina entera). */
  onCoils: { id: string; itemId: string; qty: string }[];
  /** Reservas genéricas contra la spec. */
  generic: { id: string; qty: string; orderSeq: number }[];
  /** Bobinas montadas en una OP viva. */
  mounted: string[];
  specs: (typeof SPEC)[];
}

function createFakeTx(state: FakeState) {
  const dec = (v: string) => new Prisma.Decimal(v);
  const tx = {
    coil: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        // El filtro por id (el que usa `findSpecsAffectedByAttributes`) devuelve atributos;
        // el del agregado devuelve solo los ids, que es lo que el código lee.
        const byId = (where.id as { in?: string[] } | undefined)?.in;
        const rows = byId ? state.coils.filter((c) => byId.includes(c.id)) : state.coils;
        return Promise.resolve(
          rows.map((c) => ({
            id: c.id,
            businessLineId: c.businessLineId,
            colorId: c.colorId,
            thicknessMm: dec(c.thicknessMm),
          })),
        );
      }),
    },
    rawMaterialSpec: {
      findMany: jest.fn(() =>
        Promise.resolve(
          state.specs.map((s) => ({
            id: s.id,
            businessLineId: s.businessLineId,
            colorId: s.colorId,
            thicknessMm: dec(s.thicknessMm),
          })),
        ),
      ),
    },
    inventoryBalance: {
      findMany: jest.fn(() =>
        Promise.resolve(state.balances.map((b) => ({ itemId: b.itemId, qty: dec(b.qty) }))),
      ),
    },
    productionOrderConsumption: {
      findMany: jest.fn(() =>
        Promise.resolve(
          state.mounted.map((coilId) => ({
            coilId,
            coil: { code: `COIL-${coilId}` },
            productionOrder: { id: `op-${coilId}`, seq: 1 },
          })),
        ),
      ),
    },
    reservation: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        const except = (where.id as { notIn?: string[] } | undefined)?.notIn ?? [];
        if (where.itemType === 'COIL') {
          return Promise.resolve(
            state.onCoils
              .filter((r) => !except.includes(r.id))
              .map((r) => ({ itemId: r.itemId, qty: dec(r.qty) })),
          );
        }
        return Promise.resolve(
          state.generic
            .filter((r) => !except.includes(r.id))
            .map((r) => ({ qty: dec(r.qty), salesOrder: { seq: r.orderSeq } })),
        );
      }),
      aggregate: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        const except = (where.id as { notIn?: string[] } | undefined)?.notIn ?? [];
        const total = state.generic
          .filter((r) => !except.includes(r.id))
          .reduce((acc, r) => acc.plus(dec(r.qty)), new Prisma.Decimal(0));
        return Promise.resolve({ _sum: { qty: total } });
      }),
      groupBy: jest.fn(() =>
        Promise.resolve(state.generic.length > 0 ? [{ itemId: SPEC.id }] : []),
      ),
    },
    $queryRaw: jest.fn(() => Promise.resolve([])),
  };
  return tx as unknown as PrismaTypes.TransactionClient;
}

const EMPTY: FakeState = {
  coils: [],
  balances: [],
  onCoils: [],
  generic: [],
  mounted: [],
  specs: [SPEC],
};

describe('Invariante del agregado de materia prima (D-134)', () => {
  describe('rawMaterialAvailability', () => {
    it('suma los kilos de todas las bobinas que cumplen la spec', async () => {
      const tx = createFakeTx({
        ...EMPTY,
        coils: [
          { id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.44' },
          { id: 'b', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.46' },
        ],
        balances: [
          { itemId: 'a', qty: '600' },
          { itemId: 'b', qty: '400' },
        ],
      });
      const result = await rawMaterialAvailability(tx, SPEC, TOLERANCE);
      expect(result.physical.toFixed(3)).toBe('1000.000');
      expect(result.available.toFixed(3)).toBe('1000.000');
    });

    it('descuenta lo comprometido por ítem y lo prometido de forma genérica', async () => {
      const tx = createFakeTx({
        ...EMPTY,
        coils: [{ id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' }],
        balances: [{ itemId: 'a', qty: '1000' }],
        // Una venta de bobina entera (RF-73) sobre esa misma bobina.
        onCoils: [{ id: 'r-coil', itemId: 'a', qty: '300' }],
        generic: [{ id: 'r-gen', qty: '200', orderSeq: 7 }],
      });
      const result = await rawMaterialAvailability(tx, SPEC, TOLERANCE);
      expect(result.reservedOnCoils.toFixed(3)).toBe('300.000');
      expect(result.reservedGeneric.toFixed(3)).toBe('200.000');
      expect(result.available.toFixed(3)).toBe('500.000');
    });

    it('no cuenta una bobina que una orden de producción tiene montada (D-060)', async () => {
      const tx = createFakeTx({
        ...EMPTY,
        coils: [
          { id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' },
          { id: 'b', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' },
        ],
        balances: [
          { itemId: 'a', qty: '600' },
          { itemId: 'b', qty: '400' },
        ],
        // Montar no mueve kardex, así que su saldo se ve intacto: si no se descontara acá,
        // el agregado prometería material que planta ya tiene tomado.
        mounted: ['b'],
      });
      const result = await rawMaterialAvailability(tx, SPEC, TOLERANCE);
      expect(result.physical.toFixed(3)).toBe('600.000');
      expect(result.coilIds).toEqual(['a']);
    });

    it('deja fuera de la cuenta la reserva exceptuada (la propia del pedido)', async () => {
      const tx = createFakeTx({
        ...EMPTY,
        coils: [{ id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' }],
        balances: [{ itemId: 'a', qty: '500' }],
        generic: [{ id: 'r-propia', qty: '500', orderSeq: 9 }],
      });
      const withOwn = await rawMaterialAvailability(tx, SPEC, TOLERANCE);
      expect(withOwn.available.toFixed(3)).toBe('0.000');

      const without = await rawMaterialAvailability(tx, SPEC, TOLERANCE, {
        exceptReservationIds: ['r-propia'],
      });
      expect(without.available.toFixed(3)).toBe('500.000');
    });
  });

  describe('assertRawMaterialInvariant', () => {
    it('deja pasar la operación que respeta lo prometido, hasta el límite exacto', async () => {
      const tx = createFakeTx({
        ...EMPTY,
        coils: [{ id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' }],
        balances: [{ itemId: 'a', qty: '500' }],
        generic: [{ id: 'r-gen', qty: '500', orderSeq: 12 }],
      });
      await expect(assertRawMaterialInvariant(tx, ['a'], TOLERANCE)).resolves.toBeUndefined();
    });

    it('corta la operación que dejaría al agregado por debajo de lo prometido', async () => {
      const tx = createFakeTx({
        ...EMPTY,
        coils: [{ id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' }],
        balances: [{ itemId: 'a', qty: '400' }],
        generic: [{ id: 'r-gen', qty: '500', orderSeq: 12 }],
      });
      await expect(assertRawMaterialInvariant(tx, ['a'], TOLERANCE)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('nombra el pedido que se quedaría sin material', async () => {
      const tx = createFakeTx({
        ...EMPTY,
        coils: [{ id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' }],
        balances: [{ itemId: 'a', qty: '100' }],
        generic: [{ id: 'r-gen', qty: '900', orderSeq: 12 }],
      });
      // El mensaje tiene que decir a quién se le rompe la promesa: sin eso, quien registra
      // la merma no sabe qué pedido anular ni qué reserva liberar.
      await expect(assertRawMaterialInvariant(tx, ['a'], TOLERANCE)).rejects.toThrow(/PED-/);
    });

    it('no comprueba nada cuando el agregado no tiene ninguna promesa viva', async () => {
      const tx = createFakeTx({
        ...EMPTY,
        coils: [{ id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' }],
        balances: [{ itemId: 'a', qty: '0' }],
      });
      await expect(assertRawMaterialInvariant(tx, ['a'], TOLERANCE)).resolves.toBeUndefined();
    });

    it('no bloquea a la reserva que la propia orden viene a cumplir', async () => {
      const tx = createFakeTx({
        ...EMPTY,
        coils: [{ id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' }],
        // La bobina ya no está disponible (la OP la montó) y la promesa sigue viva: sin la
        // excepción, la reserva se bloquearía a sí misma.
        balances: [{ itemId: 'a', qty: '0' }],
        generic: [{ id: 'r-propia', qty: '500', orderSeq: 15 }],
      });
      await expect(
        assertRawMaterialInvariant(tx, ['a'], TOLERANCE, {
          exceptReservationIds: ['r-propia'],
        }),
      ).resolves.toBeUndefined();
    });
  });
});
