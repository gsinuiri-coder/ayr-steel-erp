import { Decimal } from '@ayr/shared';
import {
  allocateUndispatched,
  dropSameDayReversals,
  firstNegativeDate,
  planInvoiceDispatches,
  type PlanInvoice,
  type PlanItemKardex,
} from './invoice-dispatch-plan';

const d = (v: string | number): Decimal => new Decimal(v);

function invoice(
  number: string,
  issueDate: string,
  lines: {
    itemKey: string | null;
    qty: string;
    reserveQty?: string;
    blocked?: string;
  }[],
): PlanInvoice {
  return {
    invoiceId: number,
    number,
    salesOrderId: 'ped',
    issueDate,
    lines: lines.map((l, i) => ({
      orderItemId: `${number}-${String(i + 1)}`,
      lineNumber: i + 1,
      sku: l.itemKey ?? 'X',
      qty: d(l.qty),
      target:
        l.blocked !== undefined || l.itemKey === null
          ? { ok: false, reason: l.blocked ?? 'sin destino' }
          : { ok: true, itemKey: l.itemKey, reserveQty: d(l.reserveQty ?? l.qty) },
    })),
  };
}

function kardex(openingDate: string | null, moves: [string, number][]): PlanItemKardex {
  return {
    openingDate,
    movements: moves.map(([date, qty]) => ({ date, signedQty: d(qty) })),
  };
}

describe('planInvoiceDispatches (D-278)', () => {
  it('despacha a la fecha del comprobante cuando el kardex alcanza ese día', () => {
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-09-10', [{ itemKey: 'A', qty: '30' }])],
      new Map([['A', kardex('2026-09-07', [['2026-09-07', 100]])]]),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'DISPATCH', operationDate: '2026-09-10' });
  });

  it('comprobante anterior al saldo inicial: sin salida, solo entrega (la excepción)', () => {
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-08-11', [{ itemKey: 'UPVC', qty: '50' }])],
      new Map([['UPVC', kardex('2026-09-22', [['2026-09-22', 970]])]]),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'BEFORE_OPENING' });
  });

  it('el mismo día del saldo inicial no es anterior: se despacha', () => {
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-09-22', [{ itemKey: 'UPVC', qty: '50' }])],
      new Map([['UPVC', kardex('2026-09-22', [['2026-09-22', 970]])]]),
    );
    expect(plan[0]?.lines[0]?.action).toBe('DISPATCH');
  });

  it('sin carga inicial y con la entrada posterior al comprobante: el kardex quedaría negativo → revisión', () => {
    // Coberturas facturadas en agosto y producidas en septiembre.
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-08-05', [{ itemKey: 'COB', qty: '226.8' }])],
      new Map([['COB', kardex(null, [['2026-09-15', 600]])]]),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'REVIEW' });
    expect(plan[0]?.lines[0]?.reason).toContain('2026-08-05');
  });

  it('una salida intermedia del kardex también cuenta: negativo en una fecha posterior → revisión', () => {
    // 100 el 01, sale 80 el 05, entran 50 el 09. Una salida de 30 el 02 deja -10 el 05.
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-09-02', [{ itemKey: 'A', qty: '30' }])],
      new Map([
        [
          'A',
          kardex(null, [
            ['2026-09-01', 100],
            ['2026-09-05', -80],
            ['2026-09-09', 50],
          ]),
        ],
      ]),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'REVIEW' });
    expect(plan[0]?.lines[0]?.reason).toContain('2026-09-05');
  });

  it('las salidas del mismo plan se acumulan: la segunda que no cabe va a revisión', () => {
    const plan = planInvoiceDispatches(
      [
        invoice('F1', '2026-09-10', [{ itemKey: 'A', qty: '60' }]),
        invoice('F2', '2026-09-11', [{ itemKey: 'A', qty: '60' }]),
      ],
      new Map([['A', kardex(null, [['2026-09-01', 100]])]]),
    );
    expect(plan.map((p) => p.lines[0]?.action)).toEqual(['DISPATCH', 'REVIEW']);
  });

  it('la salida usa la cantidad del kardex (kilos de la bobina), no la de venta', () => {
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-08-01', [{ itemKey: 'BOB', qty: '1', reserveQty: '3866' }])],
      new Map([['BOB', kardex(null, [['2026-08-01', 3866]])]]),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'DISPATCH' });
    expect(plan[0]?.lines[0]?.reserveQty.toFixed(3)).toBe('3866.000');
  });

  it('una línea sin producto terminado (producción no reportada) va a revisión con el motivo', () => {
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-09-10', [{ itemKey: 'A', qty: '5', blocked: 'produce lo que falta' }])],
      new Map(),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'REVIEW', reason: 'produce lo que falta' });
  });
});

describe('allocateUndispatched (D-278)', () => {
  it('lo ya despachado cubre primero los comprobantes más antiguos', () => {
    // Línea de 100, dos facturas de 40 y 60, 50 ya despachados: la primera queda cubierta y
    // de la segunda faltan 50.
    expect(allocateUndispatched(d(100), d(50), [d(40), d(60)]).map((q) => q.toFixed(3))).toEqual([
      '0.000',
      '50.000',
    ]);
  });

  it('nunca más que lo pendiente del pedido', () => {
    expect(allocateUndispatched(d(10), d(0), [d(8), d(8)]).map((q) => q.toFixed(3))).toEqual([
      '8.000',
      '2.000',
    ]);
  });
});

describe('planInvoiceDispatches — bobinas (autorrevisión P2-3)', () => {
  it('una bobina de la carga inicial no se entrega sin salida: va a revisión', () => {
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-08-11', [{ itemKey: 'COIL:b1', qty: '1', reserveQty: '3000' }])],
      new Map([['COIL:b1', kardex('2026-09-22', [['2026-09-22', 3000]])]]),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'REVIEW' });
    expect(plan[0]?.lines[0]?.reason).toContain('inventario inicial');
  });
});

describe('planInvoiceDispatches — fecha del parte de producción (D-285)', () => {
  it('la salida va el día más tardío entre la emisión y el parte de producción', () => {
    const inv = invoice('F1', '2026-08-05', [{ itemKey: 'COB', qty: '226.8' }]);
    inv.lines[0]!.notBefore = '2026-09-15';
    const plan = planInvoiceDispatches(
      [inv],
      new Map([['COB', kardex(null, [['2026-09-15', 600]])]]),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'DISPATCH', operationDate: '2026-09-15' });
  });

  it('las salidas previas del mismo arreglo se suman al kardex simulado', () => {
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-09-10', [{ itemKey: 'A', qty: '60' }])],
      new Map([['A', kardex(null, [['2026-09-01', 100]])]]),
      new Map([['A', [{ date: '2026-09-02', qty: new Decimal(50) }]]]),
    );
    expect(plan[0]?.lines[0]?.action).toBe('REVIEW');
  });
});

describe('planInvoiceDispatches — cupo de lo fabricado y reservado (D-287)', () => {
  /** Un comprobante de la misma línea de pedido `L1`, con 6 MTR fabricados y reservados. */
  function held(number: string, issueDate: string, qty: string): PlanInvoice {
    return {
      invoiceId: number,
      number,
      salesOrderId: 'ped',
      issueDate,
      lines: [
        {
          orderItemId: 'L1',
          lineNumber: 1,
          sku: 'COB',
          qty: d(qty),
          target: {
            ok: true,
            itemKey: 'A',
            reserveQty: d(qty),
            held: { qty: d(6), unit: 'MTR' },
          },
        },
      ],
    };
  }

  it('cupo insuficiente: revisión con la forma de siempre (sin ítem ni cantidad)', () => {
    const plan = planInvoiceDispatches(
      [held('F1', '2026-09-10', '8')],
      new Map([['A', kardex(null, [['2026-09-01', 100]])]]),
    );
    expect(plan[0]?.lines[0]).toMatchObject({
      action: 'REVIEW',
      itemKey: null,
      reason:
        'Hay 6.000 MTR fabricados y reservados para la línea y se facturaron 8.000: falta producir',
    });
    expect(plan[0]?.lines[0]?.reserveQty.toFixed(3)).toBe('0.000');
  });

  it('lo que va a revisión por el kardex deja el cupo al comprobante siguiente', () => {
    const plan = planInvoiceDispatches(
      [held('F1', '2026-09-05', '6'), held('F2', '2026-09-12', '6')],
      new Map([['A', kardex(null, [['2026-09-10', 100]])]]),
    );
    expect(plan.map((p) => p.lines[0]?.action)).toEqual(['REVIEW', 'DISPATCH']);
    expect(plan[0]?.lines[0]?.reason).toContain('kardex negativo');
  });

  it('lo entregado antes del inventario inicial sí gasta el cupo', () => {
    const plan = planInvoiceDispatches(
      [held('F1', '2026-08-11', '4'), held('F2', '2026-09-25', '4')],
      new Map([['A', kardex('2026-09-22', [['2026-09-22', 100]])]]),
    );
    expect(plan[0]?.lines[0]?.action).toBe('BEFORE_OPENING');
    expect(plan[1]?.lines[0]).toMatchObject({ action: 'REVIEW', itemKey: null });
    expect(plan[1]?.lines[0]?.reason).toContain('Hay 2.000 MTR');
  });

  it('un DISPATCH gasta el cupo del siguiente', () => {
    const plan = planInvoiceDispatches(
      [held('F1', '2026-09-11', '5'), held('F2', '2026-09-12', '5')],
      new Map([['A', kardex(null, [['2026-09-10', 100]])]]),
    );
    expect(plan.map((p) => p.lines[0]?.action)).toEqual(['DISPATCH', 'REVIEW']);
  });
});

describe('dropSameDayReversals (D-288)', () => {
  const mv = (id: string, date: string, reversalOfId: string | null = null) => ({
    id,
    date,
    reversalOfId,
  });

  it('saca el par salida/reversa del mismo día y deja la reversa de otro día', () => {
    const kept = dropSameDayReversals([
      mv('1', '2026-09-19'),
      mv('2', '2026-09-24'),
      mv('3', '2026-09-24', '2'),
      mv('4', '2026-09-20'),
      mv('5', '2026-09-25', '4'),
    ]);
    expect(kept.map((m) => m.id)).toEqual(['1', '4', '5']);
  });

  it('sin el par, la salida nueva anterior no ve un negativo de paso', () => {
    // Entrada de 1000 el 19; la salida vieja (24) y su reversa (24); la salida nueva el 22.
    const movements = [
      { ...mv('1', '2026-09-19'), signedQty: d(1000) },
      { ...mv('2', '2026-09-24'), signedQty: d(-1000) },
      { ...mv('3', '2026-09-24', '2'), signedQty: d(1000) },
    ];
    const out = [{ date: '2026-09-22', qty: d(1000) }];
    expect(firstNegativeDate(movements, out)).toBe('2026-09-24');
    expect(firstNegativeDate(dropSameDayReversals(movements), out)).toBeNull();
  });
});
