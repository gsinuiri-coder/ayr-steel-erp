import { FinishKind, Prisma } from '@prisma/client';
import {
  confirmQuotationSchema,
  importPaperUnit,
  importQtyInProductUnit,
  paperCoilWeightCheck,
  PAPER_COIL_WEIGHT_TOLERANCE,
  toDecimal,
} from '@ayr/shared';
import {
  paperCoilBlocker,
  resolvePaperCoilAssignments,
  unassignedPaperCoilLines,
} from './paper-coil-assignment';

/**
 * D-385: la unidad del papel, la tolerancia de peso y la elección de bobina al confirmar una
 * cotización importada con una línea «sin bobina asignada».
 */

jest.mock('../production/production-assignments', () => ({
  findLiveStripAssignments: jest.fn().mockResolvedValue([]),
}));
jest.mock('./reserved-ledger', () => ({
  reservedByItem: jest.fn().mockResolvedValue(new Map()),
}));

const D = (v: string) => new Prisma.Decimal(v);
const COIL_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_COIL_ID = '55555555-5555-4555-8555-555555555555';

describe('D-385 — unidad del papel', () => {
  it('reconoce tonelada y sus variantes sin importar mayúsculas ni espacios', () => {
    for (const u of ['TONELADA', 'tonelada', 'TN', 'Ton', 'TNE', '  Tonelada ']) {
      expect(importPaperUnit(u)).toBe('TNE');
    }
    expect(importPaperUnit('KILOGRAMO')).toBe('KGM');
    expect(importPaperUnit('METRO LINEAL')).toBe('MTR');
    expect(importPaperUnit('')).toBeNull();
    expect(importPaperUnit('QUINTAL')).toBeUndefined();
  });

  it('convierte a kilos solo cuando el producto se vende en kilos', () => {
    const tonnes = toDecimal('4.192');
    expect(importQtyInProductUnit(tonnes, 'TNE', 'KGM')).toEqual({
      qty: toDecimal('4192'),
      convertedFromTonnes: true,
    });
    // El conformado se vende en TNE: la cantidad del papel se queda.
    expect(importQtyInProductUnit(tonnes, 'TNE', 'TNE').convertedFromTonnes).toBe(false);
    expect(importQtyInProductUnit(tonnes, 'TNE', null).convertedFromTonnes).toBe(false);
    expect(importQtyInProductUnit(toDecimal('4194'), 'KGM', 'KGM').qty.toString()).toBe('4194');
  });
});

describe('D-385 — tolerancia de peso de la bobina', () => {
  it('es una sola constante de ±1 %', () => {
    expect(PAPER_COIL_WEIGHT_TOLERANCE).toBe('0.01');
  });

  it('acepta el borde y rechaza lo que pasa de él, en los dos sentidos', () => {
    expect(paperCoilWeightCheck('4192', '4192')).toEqual({
      ok: true,
      minKg: '4150.080',
      maxKg: '4233.920',
    });
    expect(paperCoilWeightCheck('4192', '4150.080').ok).toBe(true);
    expect(paperCoilWeightCheck('4192', '4233.920').ok).toBe(true);
    expect(paperCoilWeightCheck('4192', '4150.079').ok).toBe(false);
    expect(paperCoilWeightCheck('4192', '4233.921').ok).toBe(false);
  });
});

describe('D-385 — confirmQuotationSchema.coilAssignments', () => {
  it('admite una bobina por línea y rechaza dos para la misma', () => {
    expect(
      confirmQuotationSchema.safeParse({
        coilAssignments: [{ lineNumber: 1, saleCoilId: COIL_ID }],
      }).success,
    ).toBe(true);
    expect(
      confirmQuotationSchema.safeParse({
        coilAssignments: [
          { lineNumber: 1, saleCoilId: COIL_ID },
          { lineNumber: 1, saleCoilId: OTHER_COIL_ID },
        ],
      }).success,
    ).toBe(false);
  });
});

/** Una base falsa con una línea `BOB038AZUL` sin bobina y las bobinas del pool que se pasen. */
function txWith(coils: { id: string; code: string; balance: string }[]) {
  const finish = { code: 'ALZ-AZUL', kind: FinishKind.PREPINTADO, color: { code: 'AZUL' } };
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    quotationItem: {
      findMany: jest.fn(({ where }: { where: { reserveItemType: unknown } }) =>
        // `findCoilTies` pregunta por las líneas COIL de otras cotizaciones: ninguna.
        typeof where.reserveItemType === 'string'
          ? Promise.resolve([])
          : Promise.resolve([
              {
                id: 'qi-1',
                lineNumber: 1,
                qty: D('4192'),
                description: 'BOBINA ALUZINC AZUL 0.38 X 1200 RAL 5002',
                reserveItemType: 'PRODUCT',
                reserveItemId: 'p-canon',
                product: {
                  sku: 'BOB038AZUL',
                  name: 'Bobina Azul 0.38',
                  businessLine: { code: 'TRADING' },
                },
              },
            ]),
      ),
    },
    color: { findMany: jest.fn().mockResolvedValue([{ code: 'AZUL' }]) },
    coil: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          coils.map((c) => ({ id: c.id, code: c.code, widthMm: D('1200'), finish })),
        ),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ thicknessMm: D('0.38'), finish }),
    },
    inventoryBalance: {
      findMany: jest
        .fn()
        .mockResolvedValue(coils.map((c) => ({ itemId: c.id, qty: D(c.balance) }))),
    },
    businessLine: { findUnique: jest.fn().mockResolvedValue({ id: 'bl-t' }) },
    product: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'p-canon', sku: 'BOB038AZUL', name: 'Bobina Azul 0.38', businessLineId: 'bl-t' },
        ]),
    },
  };
}

const IMPORTED = { id: 'q-1', notes: 'Factura externa: FFA1-1419' };

describe('D-385 — elegir la bobina al confirmar', () => {
  it('una cotización manual no tiene líneas que elegir (su comportamiento no cambia)', async () => {
    const tx = txWith([]);
    await expect(
      unassignedPaperCoilLines(tx as never, { id: 'q-1', notes: null }),
    ).resolves.toEqual([]);
    expect(tx.quotationItem.findMany).not.toHaveBeenCalled();
    await expect(
      resolvePaperCoilAssignments(tx as never, { id: 'q-1', notes: null }, [
        { lineNumber: 1, saleCoilId: COIL_ID },
      ]),
    ).rejects.toThrow(/no es una línea de bobina sin bobina asignada/);
  });

  it('sin bobina libre que corresponda, confirmar se bloquea con un mensaje claro', async () => {
    const tx = txWith([]);
    await expect(resolvePaperCoilAssignments(tx as never, IMPORTED, [])).rejects.toThrow(
      /sin bobina asignada y no hay ninguna bobina libre de BOB038AZUL/,
    );
  });

  it('con bobina libre pero sin elegirla, pide elegirla', async () => {
    const tx = txWith([{ id: COIL_ID, code: 'BOB-0042', balance: '4190' }]);
    await expect(resolvePaperCoilAssignments(tx as never, IMPORTED, [])).rejects.toThrow(
      /Elige la bobina al confirmar/,
    );
  });

  it('la bobina dentro del ±1 % se ata y reserva su saldo entero', async () => {
    const tx = txWith([{ id: COIL_ID, code: 'BOB-0042', balance: '4180.500' }]);
    const [a] = await resolvePaperCoilAssignments(tx as never, IMPORTED, [
      { lineNumber: 1, saleCoilId: COIL_ID },
    ]);
    expect(a).toEqual({
      lineNumber: 1,
      itemId: 'qi-1',
      coilId: COIL_ID,
      coilCode: 'BOB-0042',
      productId: 'p-canon',
      paperKg: '4192.000',
      balanceKg: '4180.500',
    });
    // Sin lock propio: el lock de las bobinas lo toma `createReservations`, sobre la unión y en
    // orden de id; tomarlo antes rompía ese orden (P2-1 de las dos revisiones de cc17).
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('el re-chequeo después de reservar no se cuenta la reserva del propio pedido', async () => {
    const tx = txWith([{ id: COIL_ID, code: 'BOB-0042', balance: '4180.500' }]);
    await resolvePaperCoilAssignments(
      tx as never,
      IMPORTED,
      [{ lineNumber: 1, saleCoilId: COIL_ID }],
      { exceptSalesOrderId: 'o-1' },
    );
    const { reservedByItem } = jest.requireMock<{ reservedByItem: jest.Mock }>('./reserved-ledger');
    expect(reservedByItem).toHaveBeenLastCalledWith(expect.anything(), 'COIL', [COIL_ID], {
      exceptQuotationIds: ['q-1'],
      exceptSalesOrderIds: ['o-1'],
    });
  });

  it('el borde redondea hacia adentro y compara contra lo que muestra', () => {
    // 4192.123 ± 1 % = 4150.20177 .. 4234.04423 → se muestran y comparan 4150.202 .. 4234.044.
    expect(paperCoilWeightCheck('4192.123', '0')).toMatchObject({
      minKg: '4150.202',
      maxKg: '4234.044',
    });
    expect(paperCoilWeightCheck('4192.123', '4150.202').ok).toBe(true);
    expect(paperCoilWeightCheck('4192.123', '4150.201').ok).toBe(false);
    expect(paperCoilWeightCheck('4192.123', '4234.044').ok).toBe(true);
    expect(paperCoilWeightCheck('4192.123', '4234.045').ok).toBe(false);
  });

  it('una bobina fuera del ±1 % se bloquea mostrando los dos pesos', async () => {
    const tx = txWith([{ id: COIL_ID, code: 'BOB-0042', balance: '4100' }]);
    await expect(
      resolvePaperCoilAssignments(tx as never, IMPORTED, [{ lineNumber: 1, saleCoilId: COIL_ID }]),
    ).rejects.toThrow(/BOB-0042 tiene 4100\.000 kg y el papel dice 4192\.000 kg/);
  });

  it('una bobina que no está libre en el pool se rechaza', async () => {
    const tx = txWith([{ id: COIL_ID, code: 'BOB-0042', balance: '4192' }]);
    await expect(
      resolvePaperCoilAssignments(tx as never, IMPORTED, [
        { lineNumber: 1, saleCoilId: OTHER_COIL_ID },
      ]),
    ).rejects.toThrow(/no está libre en el pool/);
  });

  it('el aviso de la vista previa nombra las bobinas fuera de rango', async () => {
    const tx = txWith([]);
    const [line] = await unassignedPaperCoilLines(tx as never, IMPORTED);
    expect(line).toBeDefined();
    if (!line) return;
    expect(
      paperCoilBlocker(line, [
        {
          coilId: COIL_ID,
          code: 'BOB-0042',
          widthMm: '1200.00',
          balanceKg: '3000.000',
          withinTolerance: false,
        },
      ]),
    ).toMatch(/ninguna bobina libre de BOB038AZUL pesa lo del papel.*BOB-0042 tiene 3000\.000 kg/);
    expect(
      paperCoilBlocker(line, [
        {
          coilId: COIL_ID,
          code: 'BOB-0042',
          widthMm: '1200.00',
          balanceKg: '4192.000',
          withinTolerance: true,
        },
      ]),
    ).toBeNull();
  });
});
