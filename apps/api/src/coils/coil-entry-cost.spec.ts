import { Prisma } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import { adjustedDeltas, correctCoilEntryCost } from './coil-entry-cost';
import { entryCostViolations, type EntryCostFacts } from './coil-entry-cost-checks';

jest.mock('../inventory/row-locks', () => ({ lockCoilRows: jest.fn(() => Promise.resolve([])) }));

const D = (v: string) => new Prisma.Decimal(v);

function fakeTx(over: { entries?: unknown[]; recost?: string | null; coil?: unknown } = {}) {
  return {
    coil: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          over.coil === undefined
            ? {
                id: 'coil-1',
                code: 'COIL-1',
                status: 'CLOSED',
                exchangeRate: D('1'),
                weightKg: D('4150'),
                unitCostPerKg: D('2.6938'),
                totalCostPen: D('11179.27'),
              }
            : over.coil,
        ),
      ),
      update: jest.fn((..._a: unknown[]) => Promise.resolve({})),
    },
    inventoryMovement: {
      findMany: jest.fn(() =>
        Promise.resolve(over.entries ?? [{ id: 468n, qty: D('4150'), totalCost: D('11179.27') }]),
      ),
      aggregate: jest.fn(() =>
        Promise.resolve({
          _sum: { totalCost: over.recost === undefined ? null : over.recost && D(over.recost) },
        }),
      ),
    },
  };
}

type Tx = Parameters<typeof correctCoilEntryCost>[0];

function deps() {
  const outcome = {
    pending: false,
    rowsReplayed: 2,
    adjusted: [
      {
        movement: { id: 468n, type: 'IN', refType: 'PURCHASE', refId: 'p' },
        delta: new Decimal('731.23'),
        target: new Decimal('11910.5'),
        item: { itemType: 'COIL', itemId: 'coil-1' },
      },
    ],
  };
  return {
    inventory: { recostEntries: jest.fn((..._a: unknown[]) => Promise.resolve(outcome as never)) },
    audit: { write: jest.fn((..._a: unknown[]) => Promise.resolve()) },
  };
}

const input = {
  coilId: 'coil-1',
  unitCostPerKg: new Decimal('2.87'),
  costReason: 'PURCHASE_CORRECTION' as const,
  detail: 'costo del papel',
};

describe('correctCoilEntryCost (D-669)', () => {
  it('sube la entrada viva a peso × costo × TC por el recosteo, corrige la ficha y audita', async () => {
    const tx = fakeTx();
    const d = deps();
    const r = await correctCoilEntryCost(tx as unknown as Tx, d, 'admin', input);
    expect(r).toMatchObject({
      entryMovementId: '468',
      fromPen: '11179.2700',
      toPen: '11910.5000',
      addPen: '731.2300',
    });
    expect(d.inventory.recostEntries).toHaveBeenCalledWith(
      tx,
      [{ movementId: 468n, addPen: new Decimal('731.23') }],
      { actorId: 'admin', note: 'Corrección de la compra: costo del papel' },
    );
    expect(tx.coil.update).toHaveBeenCalledWith({
      where: { id: 'coil-1' },
      data: { unitCostPerKg: '2.8700', totalCost: '11910.5000', totalCostPen: '11910.5000' },
    });
    expect(d.audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'coils.entry-cost-correction',
        reason: 'Corrección de la compra: costo del papel',
      }),
    );
    expect(adjustedDeltas(r.outcome)).toEqual([
      { movementId: '468', type: 'IN', refType: 'PURCHASE', refId: 'p', delta: '731.2300' },
    ]);
  });

  it('cuenta los recosteos previos de la entrada', async () => {
    const d = deps();
    const r = await correctCoilEntryCost(
      fakeTx({ recost: '100' }) as unknown as Tx,
      d,
      'admin',
      input,
    );
    expect(r.fromPen).toBe('11279.2700');
    expect(r.addPen).toBe('631.2300');
  });

  it('sin diferencia no recostea', async () => {
    const d = deps();
    const r = await correctCoilEntryCost(
      fakeTx({ entries: [{ id: 1n, qty: D('4150'), totalCost: D('11910.5') }] }) as unknown as Tx,
      d,
      'admin',
      input,
    );
    expect(r.outcome).toBeNull();
    expect(d.inventory.recostEntries).not.toHaveBeenCalled();
    expect(adjustedDeltas(null)).toEqual([]);
  });

  it.each([
    [{ coil: null }, /no encontrada/],
    [{ coil: { status: 'CANCELLED' } }, /anulada/],
    [{ entries: [] }, /0 entradas vivas/],
  ])('rechaza %o', async (over, message) => {
    await expect(
      correctCoilEntryCost(fakeTx(over) as unknown as Tx, deps(), 'a', input),
    ).rejects.toThrow(message);
  });

  it('rechaza un costo no positivo y un recosteo que pasa el tope', async () => {
    await expect(
      correctCoilEntryCost(fakeTx() as unknown as Tx, deps(), 'a', {
        ...input,
        unitCostPerKg: new Decimal(0),
      }),
    ).rejects.toThrow(/mayor que cero/);
    const d = deps();
    d.inventory.recostEntries.mockResolvedValueOnce({
      pending: true,
      rowsReplayed: 0,
      adjusted: [],
    } as never);
    await expect(correctCoilEntryCost(fakeTx() as unknown as Tx, d, 'a', input)).rejects.toThrow(
      /tope/,
    );
  });
});

describe('entryCostViolations (condiciones del OK de C2)', () => {
  const facts = (over: Partial<EntryCostFacts> = {}): EntryCostFacts => ({
    coilId: 'c',
    entryMovementId: '468',
    addPen: '731.23',
    adjusted: [
      { movementId: '468', itemId: 'c', type: 'IN', refType: 'PURCHASE', delta: '731.2300' },
      { movementId: '960', itemId: 'c', type: 'OUT', refType: 'SALE', delta: '731.2300' },
    ],
    documents: [
      {
        number: 'F-1448',
        profitabilityBefore: '11179.27',
        profitabilityAfter: '11910.50',
        marginBefore: '11179.27',
        marginAfter: '11910.50',
      },
    ],
    balanceQtyBefore: '0',
    balanceQtyAfter: '0',
    balanceValueBefore: '0',
    balanceValueAfter: '0',
    qtyChangingRows: 0,
    ...over,
  });
  const expected = { document: 'F-1448', deltaPen: '731.23' };

  it('el caso de C2 cumple todo', () => {
    expect(entryCostViolations(facts(), expected)).toEqual([]);
  });

  it('nombra cada condición que no se cumple', () => {
    const v = entryCostViolations(
      facts({
        addPen: '700',
        adjusted: [
          { movementId: '1', itemId: 'otro', type: 'OUT', refType: 'SALE', delta: '1' },
          { movementId: '2', itemId: 'c', type: 'OUT', refType: 'SCRAP', delta: '5' },
        ],
        documents: [],
        balanceQtyAfter: '-1',
        balanceValueAfter: '5',
        qtyChangingRows: 1,
      }),
      expected,
    );
    expect(v).toEqual([
      'la entrada sube 700 y se esperaba 731.23',
      'el recosteo alcanza 1 movimiento(s) de otros ítems',
      'la entrada no quedó ajustada una sola vez',
      'el recosteo ajusta salidas de la bobina que no son la venta',
      'las salidas suben 5.0000 y la entrada 731.23: no cuadra al céntimo',
      'cambia el costo de ningún comprobante y se esperaba solo F-1448',
      'la cantidad en kardex de la bobina cambió',
      'el saldo de la bobina queda negativo',
      'el valor del saldo de la bobina pasa de 0 a 5',
      'la corrida escribió movimientos con cantidad',
    ]);
  });

  it('los reportes tienen que moverse lo mismo', () => {
    const v = entryCostViolations(
      facts({
        documents: [
          {
            number: 'F-1448',
            profitabilityBefore: '0',
            profitabilityAfter: '700',
            marginBefore: '0',
            marginAfter: '731.23',
          },
        ],
      }),
      expected,
    );
    expect(v).toEqual(['F-1448: Rentabilidad cambia 700.00, no 731.23']);
  });
});
