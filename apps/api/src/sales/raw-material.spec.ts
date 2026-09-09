import { BadRequestException } from '@nestjs/common';
import { Prisma, type Prisma as PrismaTypes } from '@prisma/client';
import {
  assertRawMaterialInvariant,
  findRawMaterialShortfalls,
  rawMaterialAvailability,
} from './raw-material';

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
  generic: { id: string; qty: string; orderSeq: number; salesOrderId?: string }[];
  /**
   * Bobinas montadas en una OP viva (D-154). `reservationId` es lo que decide cuánto retiene
   * el agregado: una corrida que nace de un pedido aporta **cero** —su compromiso ya está
   * contado como reserva genérica y sumarlo dos veces era el defecto— y una corrida a stock
   * aporta `assignedKg − consumedKg`, que es su única representación.
   */
  mounted: {
    coilId: string;
    assignedKg: string;
    consumedKg?: string;
    reservationId?: string | null;
  }[];
  specs: (typeof SPEC)[];
}

/**
 * El `where` que arma `reservationScopeWhere`, aplicado a mano: las dos exclusiones (por
 * reserva y por pedido) tienen que valer a la vez, que es justo lo que D-154 agregó.
 */
function scopeFilter(where: Record<string, unknown>) {
  const exceptIds = (where.id as { notIn?: string[] } | undefined)?.notIn ?? [];
  const exceptOrders = (where.salesOrderId as { notIn?: string[] } | undefined)?.notIn ?? [];
  return (row: { id: string; salesOrderId?: string }) =>
    !exceptIds.includes(row.id) &&
    !(row.salesOrderId !== undefined && exceptOrders.includes(row.salesOrderId));
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
          state.mounted.map((m) => ({
            coilId: m.coilId,
            assignedKg: dec(m.assignedKg),
            consumedKg: dec(m.consumedKg ?? '0'),
            coil: { code: `COIL-${m.coilId}` },
            productionOrder: {
              id: `op-${m.coilId}`,
              seq: 1,
              reservationId: m.reservationId ?? null,
            },
          })),
        ),
      ),
    },
    reservation: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        const keep = scopeFilter(where);
        if (where.itemType === 'COIL') {
          return Promise.resolve(
            state.onCoils
              .filter((r) => keep({ id: r.id }))
              .map((r) => ({ itemId: r.itemId, qty: dec(r.qty) })),
          );
        }
        return Promise.resolve(
          state.generic
            .filter(keep)
            .map((r) => ({ qty: dec(r.qty), salesOrder: { seq: r.orderSeq } })),
        );
      }),
      aggregate: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        const total = state.generic
          .filter(scopeFilter(where))
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

    it('no cuenta los kilos que una corrida A STOCK retiene (D-060)', async () => {
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
        // Montar no mueve kardex, así que el saldo se ve intacto. Una corrida a stock no
        // tiene reserva que la represente: si no se descontara acá, el agregado prometería
        // material que planta ya tiene tomado.
        mounted: [{ coilId: 'b', assignedKg: '400' }],
      });
      const result = await rawMaterialAvailability(tx, SPEC, TOLERANCE);
      expect(result.physical.toFixed(3)).toBe('600.000');
      expect(result.mountedKg.toFixed(3)).toBe('400.000');
    });

    it('D-154: una corrida A STOCK que monta una porción deja el resto en el agregado', async () => {
      const tx = createFakeTx({
        ...EMPTY,
        coils: [{ id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' }],
        balances: [{ itemId: 'a', qty: '5000' }],
        mounted: [{ coilId: 'a', assignedKg: '200' }],
      });
      const result = await rawMaterialAvailability(tx, SPEC, TOLERANCE);
      expect(result.physical.toFixed(3)).toBe('4800.000');
      expect(result.mountedKg.toFixed(3)).toBe('200.000');
    });

    it('D-154: lo ya consumido no se descuenta dos veces', async () => {
      const tx = createFakeTx({
        ...EMPTY,
        coils: [{ id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' }],
        // El kardex ya bajó los 150 kg rolados: el saldo es 850 y la custodia viva son los
        // 50 kg que la corrida a stock todavía tiene asignados sin gastar.
        balances: [{ itemId: 'a', qty: '850' }],
        mounted: [{ coilId: 'a', assignedKg: '200', consumedKg: '150' }],
      });
      const result = await rawMaterialAvailability(tx, SPEC, TOLERANCE);
      expect(result.physical.toFixed(3)).toBe('800.000');
    });

    /**
     * El caso que motivó D-154 y el que el ALTO de la revisión encontró: con la custodia
     * medida por `assignedKg`, la capa (b) no se activaba nunca, porque `mountCoil` monta el
     * **rollo entero** salvo que alguien pase `qtyKg` — y nadie lo pasa. La regla no es "lo
     * asignado": es que **una corrida con pedido detrás ya está contada en su reserva**.
     */
    it('D-154: la corrida DE UN PEDIDO no saca del agregado el rollo que montó', async () => {
      const tx = createFakeTx({
        ...EMPTY,
        coils: [{ id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' }],
        balances: [{ itemId: 'a', qty: '5000' }],
        // El rollo entero montado, como monta la pantalla de verdad.
        mounted: [{ coilId: 'a', assignedKg: '5000', reservationId: 'r-propia' }],
        // Y su compromiso, que es lo que de verdad va a consumir.
        generic: [{ id: 'r-propia', qty: '200', orderSeq: 3, salesOrderId: 'ped-3' }],
      });
      const result = await rawMaterialAvailability(tx, SPEC, TOLERANCE);
      expect(result.physical.toFixed(3)).toBe('5000.000');
      expect(result.mountedKg.toFixed(3)).toBe('0.000');
      // 5 000 físicos menos los 200 que el pedido todavía debe: el material que vuelve al
      // almacén cuando la orden cierre está disponible para prometer, y lo estaba siempre.
      expect(result.available.toFixed(3)).toBe('4800.000');
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

  /**
   * D-154. Los tres casos que el rediseño tenía que resolver, en el orden en que aparecieron
   * en planta: el auto-bloqueo del propio pedido, el falso positivo del rollo grande y el
   * riesgo de verdad —que ahora avisa en vez de cortar—.
   */
  describe('D-154 — el pedido no se bloquea a sí mismo y el faltante avisa', () => {
    it('la promesa de una línea hermana del MISMO pedido no genera aviso', async () => {
      const tx = createFakeTx({
        ...EMPTY,
        coils: [{ id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' }],
        // El rollo entero montado en la OP de la línea 1 y, viva, la promesa de la línea 2
        // del mismo pedido. Es exactamente el "dejaría 0.000 kg libres… prometidos a
        // PED-000003" que planta reportó sobre el pedido que estaba fabricando.
        balances: [{ itemId: 'a', qty: '100' }],
        mounted: [{ coilId: 'a', assignedKg: '100', reservationId: 'r-linea-1' }],
        generic: [
          { id: 'r-linea-1', qty: '200', orderSeq: 3, salesOrderId: 'ped-3' },
          { id: 'r-linea-2', qty: '150', orderSeq: 3, salesOrderId: 'ped-3' },
        ],
      });
      const shortfalls = await findRawMaterialShortfalls(tx, ['a'], TOLERANCE, {
        exceptReservationIds: ['r-linea-1'],
        exceptSalesOrderIds: ['ped-3'],
      });
      expect(shortfalls).toEqual([]);
    });

    it('exceptuar solo la reserva propia dejaba pasar el auto-bloqueo', async () => {
      // El mismo escenario **sin** la exclusión por pedido, que es como estaba antes: la
      // hermana bloqueaba. Es el test que se cae si alguien vuelve a quitar
      // `exceptSalesOrderIds` creyendo que la reserva alcanza.
      const tx = createFakeTx({
        ...EMPTY,
        coils: [{ id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' }],
        balances: [{ itemId: 'a', qty: '100' }],
        mounted: [{ coilId: 'a', assignedKg: '100', reservationId: 'r-linea-1' }],
        generic: [
          { id: 'r-linea-1', qty: '200', orderSeq: 3, salesOrderId: 'ped-3' },
          { id: 'r-linea-2', qty: '150', orderSeq: 3, salesOrderId: 'ped-3' },
        ],
      });
      const shortfalls = await findRawMaterialShortfalls(tx, ['a'], TOLERANCE, {
        exceptReservationIds: ['r-linea-1'],
      });
      expect(shortfalls).toHaveLength(1);
      expect(shortfalls[0]?.shortfallKg).toBe('50.000');
    });

    it('un pool sano con una bobina grande montada no avisa nada', async () => {
      const tx = createFakeTx({
        ...EMPTY,
        coils: [{ id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' }],
        balances: [{ itemId: 'a', qty: '5000' }],
        // El rollo entero montado por la OP del pedido propio, y 800 kg prometidos a otro:
        // sobra material de sobra y no hay nada que avisar.
        mounted: [{ coilId: 'a', assignedKg: '5000', reservationId: 'r-propia' }],
        generic: [{ id: 'r-ajena', qty: '800', orderSeq: 9, salesOrderId: 'ped-9' }],
      });
      const shortfalls = await findRawMaterialShortfalls(tx, ['a'], TOLERANCE, {
        exceptSalesOrderIds: ['ped-3'],
      });
      expect(shortfalls).toEqual([]);
    });

    it('un pool en riesgo de verdad avisa, nombra el pedido y no lanza', async () => {
      const tx = createFakeTx({
        ...EMPTY,
        coils: [{ id: 'a', businessLineId: LINE, colorId: 'rojo', thicknessMm: '0.45' }],
        // 300 kg físicos contra 500 prometidos a un pedido ajeno: el faltante es real y no
        // lo inventa el montaje.
        balances: [{ itemId: 'a', qty: '300' }],
        mounted: [{ coilId: 'a', assignedKg: '300', reservationId: 'r-propia' }],
        generic: [{ id: 'r-ajena', qty: '500', orderSeq: 9, salesOrderId: 'ped-9' }],
      });
      const shortfalls = await findRawMaterialShortfalls(tx, ['a'], TOLERANCE, {
        exceptSalesOrderIds: ['ped-3'],
      });
      expect(shortfalls).toHaveLength(1);
      expect(shortfalls[0]?.freeKg).toBe('300.000');
      expect(shortfalls[0]?.promisedKg).toBe('500.000');
      expect(shortfalls[0]?.shortfallKg).toBe('200.000');
      expect(shortfalls[0]?.orders).toEqual([{ code: 'PED-000009', qtyKg: '500.000' }]);
      expect(shortfalls[0]?.message).toContain('PED-000009');
      // La mitad que importa: fuera de producción la misma lectura sigue siendo un rechazo.
      await expect(
        assertRawMaterialInvariant(tx, ['a'], TOLERANCE, { exceptSalesOrderIds: ['ped-3'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
